FROM python:3.11-slim

# Install system dependencies: ffmpeg for audio conversion, curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Configure python environment
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MEETING_SERVICE_HOST=0.0.0.0 \
    MEETING_SERVICE_PORT=5001 \
    MEETING_STORAGE_DIR=/app/storage

# Install dependencies first for better Docker layer caching
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy service source code
COPY . .

# Ensure storage directories exist
RUN mkdir -p /app/storage/recordings /app/storage/chunks

EXPOSE 5001

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:5001/api/health || exit 1

CMD ["python", "app.py"]
