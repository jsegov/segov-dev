"""Tests for chat API routes."""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock, MagicMock
from langchain_core.messages import AIMessage
from app.main import app


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


@pytest.fixture
def mock_openai_key(monkeypatch):
    """Mock OpenAI API key."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")


@patch('app.routes_chat.settings')
def test_chat_endpoint_success(mock_settings, client, mock_openai_key):
    """Test successful non-streaming chat request."""
    # Disable MCP to test chain path directly
    mock_settings.use_mcp_in_chat = False
    
    mock_chain = MagicMock()
    mock_chain.ainvoke = AsyncMock(return_value="Test response")
    
    with patch('app.routes_chat.create_chain_with_history', return_value=mock_chain):
        response = client.post(
            "/v1/chat",
            json={
                "session_id": "test-session",
                "input": "Hello",
            },
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "text" in data
        assert data["text"] == "Test response"
        mock_chain.ainvoke.assert_called_once()


def test_chat_endpoint_missing_input(client, mock_openai_key):
    """Test chat endpoint with missing input."""
    response = client.post(
        "/v1/chat",
        json={
            "session_id": "test-session",
        },
    )
    
    assert response.status_code == 422  # Validation error


@patch('app.routes_chat.settings')
def test_chat_endpoint_error_handling(mock_settings, client, mock_openai_key):
    """Test chat endpoint error handling."""
    # Disable MCP to test chain path directly
    mock_settings.use_mcp_in_chat = False
    
    mock_chain = MagicMock()
    mock_chain.ainvoke = AsyncMock(side_effect=Exception("Test error"))
    
    with patch('app.routes_chat.create_chain_with_history', return_value=mock_chain):
        response = client.post(
            "/v1/chat",
            json={
                "session_id": "test-session",
                "input": "Hello",
            },
        )
        
        assert response.status_code == 500
        data = response.json()
        assert "detail" in data


@patch('app.routes_chat.settings')
def test_chat_stream_endpoint_success(mock_settings, client, mock_openai_key):
    """Test successful streaming chat request."""
    # Disable MCP to test chain path directly
    mock_settings.use_mcp_in_chat = False
    
    async def mock_stream():
        yield "token1"
        yield "token2"
        yield "token3"
    
    mock_chain = MagicMock()
    # astream should return an async generator, not a coroutine
    mock_chain.astream = lambda *args, **kwargs: mock_stream()
    
    with patch('app.routes_chat.create_chain_with_history', return_value=mock_chain):
        response = client.post(
            "/v1/chat/stream",
            json={
                "session_id": "test-session",
                "input": "Hello",
            },
        )
        
        assert response.status_code == 200
        # Note: SSE streams are harder to test with TestClient,
        # but we verify the endpoint doesn't crash


@patch('app.routes_chat.settings')
def test_chat_endpoint_with_mcp_agent(mock_settings, client, mock_openai_key):
    """Test chat endpoint with MCP agent enabled."""
    # Mock MCP agent
    mock_agent = AsyncMock()
    mock_agent.ainvoke = AsyncMock(return_value={"output": "MCP agent response"})
    
    mock_settings.use_mcp_in_chat = True
    mock_settings.chat_model_id = 'Qwen/Qwen3-8B'
    
    # Mock async context manager (build_agent_with_mcp is now an async context manager)
    # Create a mock that acts as an async context manager
    mock_context_manager = MagicMock()
    mock_context_manager.__aenter__ = AsyncMock(return_value=mock_agent)
    mock_context_manager.__aexit__ = AsyncMock(return_value=None)
    
    # Patch at the import location in routes_chat
    with patch('app.agent.build_agent_with_mcp', return_value=mock_context_manager):
        response = client.post(
            "/v1/chat",
            json={
                "session_id": "test-session",
                "input": "Hello",
            },
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "text" in data
        assert data["text"] == "MCP agent response"


@patch('app.routes_chat.settings')
def test_chat_endpoint_mcp_fallback(mock_settings, client, mock_openai_key):
    """Test chat endpoint falls back to chain when MCP fails."""
    mock_settings.use_mcp_in_chat = True
    mock_settings.chat_model_id = 'Qwen/Qwen3-8B'
    
    # Patch at the import location in routes_chat
    # build_agent_with_mcp is now an async context manager, so we need to raise on __aenter__
    mock_context_manager = MagicMock()
    mock_context_manager.__aenter__ = AsyncMock(side_effect=Exception("MCP connection failed"))
    mock_context_manager.__aexit__ = AsyncMock(return_value=None)
    
    mock_chain = MagicMock()
    mock_chain.ainvoke = AsyncMock(return_value="Fallback response")
    
    with patch('app.agent.build_agent_with_mcp', return_value=mock_context_manager):
        # Should fall back to chain
        with patch('app.routes_chat.create_chain_with_history', return_value=mock_chain):
            response = client.post(
                "/v1/chat",
                json={
                    "session_id": "test-session",
                    "input": "Hello",
                },
            )
            
            assert response.status_code == 200
            data = response.json()
            assert "text" in data
            assert data["text"] == "Fallback response"


@patch('app.routes_chat.settings')
def test_chat_endpoint_mcp_agent_with_messages(mock_settings, client, mock_openai_key):
    """Test chat endpoint with MCP agent returning messages without output key."""
    # Mock MCP agent - agent is invoked directly now (no RunnableWithMessageHistory wrapper)
    mock_agent = AsyncMock()
    # Return dict with messages list containing AIMessage (simulating LangGraph output)
    mock_agent.ainvoke = AsyncMock(return_value={
        "messages": [
            AIMessage(content="Response from AIMessage in messages")
        ]
    })
    
    mock_settings.use_mcp_in_chat = True
    mock_settings.chat_model_id = 'Qwen/Qwen3-8B'
    
    # Mock async context manager
    mock_context_manager = MagicMock()
    mock_context_manager.__aenter__ = AsyncMock(return_value=mock_agent)
    mock_context_manager.__aexit__ = AsyncMock(return_value=None)
    
    # Mock session history to return empty messages list
    mock_history = MagicMock()
    mock_history.messages = []
    mock_history.add_user_message = MagicMock()
    mock_history.add_ai_message = MagicMock()
    
    with patch('app.agent.build_agent_with_mcp', return_value=mock_context_manager):
        with patch('app.routes_chat.get_session_history', return_value=mock_history):
            response = client.post(
                "/v1/chat",
                json={
                    "session_id": "test-session",
                    "input": "Hello",
                },
            )
            
            assert response.status_code == 200
            data = response.json()
            assert "text" in data
            assert data["text"] == "Response from AIMessage in messages"
            # Verify history was updated
            mock_history.add_user_message.assert_called_once_with("Hello")
            mock_history.add_ai_message.assert_called_once_with("Response from AIMessage in messages")


def test_chat_endpoint_rejects_system_field(client, mock_openai_key):
    """Test chat endpoint rejects system field in request."""
    response = client.post(
        "/v1/chat",
        json={
            "session_id": "test-session",
            "input": "Hello",
            "system": "You are a test assistant",
        },
    )
    
    assert response.status_code == 422  # Validation error - extra field not allowed

