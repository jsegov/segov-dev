import pytest
from fastapi.testclient import TestClient
from app.main import app
from langsmith import testing as t

client = TestClient(app)

@pytest.mark.langsmith
@pytest.mark.parametrize(
    "input_text, expected_behavior, expected_content",
    [
        ("What is 2+2?", "refusal", ["Jonathan", "cannot", "sorry", "only answer"]),
        ("Who is the president of the US?", "refusal", ["Jonathan", "cannot", "sorry", "only answer"]),
        ("Who is Jonathan?", "answer", ["Jonathan", "engineer", "developer"]),
    ]
)
def test_chat_evaluation(input_text, expected_behavior, expected_content):
    """Evaluate chat endpoint responses."""
    response = client.post(
        "/v1/chat",
        json={"session_id": "eval-session", "input": input_text}
    )
    assert response.status_code == 200
    data = response.json()
    assert "text" in data
    output = data["text"]
    
    # Log feedback to LangSmith
    score = 0.0
    if expected_behavior == "refusal":
        # For refusal, we expect the output to contain words indicating it can't answer or mentions Jonathan
        if any(phrase.lower() in output.lower() for phrase in expected_content):
            score = 1.0
    elif expected_behavior == "answer":
        # For answer, we expect relevant keywords about Jonathan
        if any(phrase.lower() in output.lower() for phrase in expected_content):
            score = 1.0
            
    t.log_feedback(
        key="correctness",
        score=score
    )
    assert score == 1.0, f"Evaluation failed: Expected behavior '{expected_behavior}' not met in output: {output}"
