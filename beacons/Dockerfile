# Gondor, Rohan and the riders, one image each: docker build --target gondor|rohan|riders .
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS base

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PYTHONUNBUFFERED=1 PYTHONUTF8=1
WORKDIR /app

# The packages first, so that a change of code does not install them again
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

ENV PATH="/opt/venv/bin:$PATH"
USER nobody


FROM base AS gondor
COPY gondor ./gondor
EXPOSE 8101
CMD ["uvicorn", "gondor.app:app", "--host", "0.0.0.0", "--port", "8101", "--no-access-log"]


FROM base AS rohan
COPY rohan ./rohan
EXPOSE 8102
CMD ["uvicorn", "rohan.app:app", "--host", "0.0.0.0", "--port", "8102", "--no-access-log"]


FROM base AS riders
COPY riders ./riders
CMD ["python", "-m", "riders"]
