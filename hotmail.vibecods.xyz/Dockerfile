FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HUB_HOST=0.0.0.0 HUB_PORT=8080 HUB_DATA_DIR=/app/data HUB_DB_PATH=/app/db/hub.db
WORKDIR /app
RUN useradd --system --uid 10001 hub && mkdir -p /app/data /app/db && chown -R hub /app/data /app/db
COPY hotmailhub ./hotmailhub
USER hub
VOLUME ["/app/data", "/app/db"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/v1/health', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "hotmailhub", "serve"]
