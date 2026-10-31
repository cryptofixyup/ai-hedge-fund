from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import os
from dotenv import load_dotenv
import logging
import asyncio

load_dotenv()

from app.backend.routes import api_router
from app.backend.database.connection import engine
from app.backend.database.models import Base
from app.backend.services.ollama_service import ollama_service
from app.backend.security import is_authorized_client

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Hedge Fund API", description="Backend API for AI Hedge Fund", version="0.1.0")

# Remote clients must authenticate with a backend-only token. Local development
# remains available over loopback; forwarded client-IP headers are not trusted.
API_ACCESS_TOKEN = os.getenv("AI_HEDGE_FUND_API_TOKEN", "").strip()
if API_ACCESS_TOKEN and len(API_ACCESS_TOKEN) < 32:
    raise RuntimeError("AI_HEDGE_FUND_API_TOKEN must contain at least 32 characters")
TRUSTED_PROXY_HOSTS = {
    host.strip()
    for host in os.getenv("AI_HEDGE_FUND_TRUSTED_PROXY", "").split(",")
    if host.strip()
}

@app.middleware("http")
async def restrict_remote_clients(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path in {"/", "/ping"}:
        return await call_next(request)

    client_host = request.client.host if request.client else None
    if not is_authorized_client(
        client_host,
        request.headers.get("authorization"),
        API_ACCESS_TOKEN or None,
        request.headers.get("x-forwarded-for"),
        TRUSTED_PROXY_HOSTS,
    ):
        return JSONResponse(
            status_code=403,
            content={"detail": "Remote access is disabled or requires a valid backend Bearer token."},
        )
    return await call_next(request)

# Initialize database tables (this is safe to run multiple times)
Base.metadata.create_all(bind=engine)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],  # Frontend URLs
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include all routes
app.include_router(api_router)

@app.on_event("startup")
async def startup_event():
    """Startup event to check Ollama availability."""
    try:
        logger.info("Checking Ollama availability...")
        status = await ollama_service.check_ollama_status()
        
        if status["installed"]:
            if status["running"]:
                logger.info(f"✓ Ollama is installed and running at {status['server_url']}")
                if status["available_models"]:
                    logger.info(f"✓ Available models: {', '.join(status['available_models'])}")
                else:
                    logger.info("ℹ No models are currently downloaded")
            else:
                logger.info("ℹ Ollama is installed but not running")
                logger.info("ℹ You can start it from the Settings page or manually with 'ollama serve'")
        else:
            logger.info("ℹ Ollama is not installed. Install it to use local models.")
            logger.info("ℹ Visit https://ollama.com to download and install Ollama")
            
    except Exception as e:
        logger.warning(f"Could not check Ollama status: {e}")
        logger.info("ℹ Ollama integration is available if you install it later")
