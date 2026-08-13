import base64
import logging
from fastapi import Request

logger = logging.getLogger("auth_service")

def get_current_username(request: Request) -> str:
    """
    Extract username from NPM Access List or Basic Auth headers.
    Checks:
    - x-remote-user / x-forwarded-user / remote-user / x-user
    - authorization (Basic auth base64)
    Fallback to 'invitado' if no user header is present.
    """
    # 1. Check proxy user headers (Nginx $remote_user)
    for header_name in ["x-remote-user", "x-forwarded-user", "remote-user", "x-user", "x-auth-user"]:
        user_val = request.headers.get(header_name)
        if user_val and user_val.strip() and user_val.strip() != "-":
            logger.info(f"User identified via '{header_name}': {user_val.strip()}")
            return user_val.strip()

    # 2. Check Authorization header (Basic Auth)
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.startswith("Basic "):
        try:
            encoded_credentials = auth_header.split(" ")[1]
            decoded_bytes = base64.b64decode(encoded_credentials)
            decoded_str = decoded_bytes.decode("utf-8", errors="ignore")
            if ":" in decoded_str:
                username = decoded_str.split(":")[0].strip()
                if username and username != "-":
                    logger.info(f"User identified via Authorization: {username}")
                    return username
        except Exception as e:
            logger.debug(f"Error decoding Authorization header: {e}")

    # Log headers for diagnostic inspection
    logger.info(f"No user header matched. Available headers: {list(request.headers.keys())}")
    return "invitado"
