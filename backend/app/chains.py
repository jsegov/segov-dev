"""LangChain chain configuration for chat."""
from pathlib import Path
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI
from app.config import settings
from app.cloudrun_auth import get_auth_headers


# Load system prompt from file
_PROMPT_FILE = Path(__file__).parent / "prompts" / "system_prompt.md"
SYSTEM_PROMPT = _PROMPT_FILE.read_text().strip()


def create_chain(model: str | None = None, temperature: float | None = None):
    """Create a LangChain LCEL pipeline.
    
    Args:
        model: Model name override (defaults to settings.chat_model_id)
        temperature: Temperature override (defaults to 0.2)
    
    Returns:
        LCEL chain: prompt | llm | parser
    """
    prompt = ChatPromptTemplate.from_messages([
        ("system", "{system}"),
        MessagesPlaceholder(variable_name="history"),
        ("human", "{input}"),
    ])
    
    model_name = model or settings.chat_model_id
    temp = temperature if temperature is not None else 0.2
    
    llm_kwargs = {
        'model': model_name,
        'temperature': temp,
        'streaming': True,
        'api_key': settings.openai_api_key,
    }
    if settings.openai_base_url:
        llm_kwargs['base_url'] = settings.openai_base_url
        llm_kwargs['default_headers'] = get_auth_headers(settings.openai_base_url)

    llm = ChatOpenAI(**llm_kwargs)
    
    return prompt | llm | StrOutputParser()

