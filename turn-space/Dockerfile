FROM python:3.12-slim

WORKDIR /app
COPY server.py /app/server.py
USER 1000
EXPOSE 7860
CMD ["python", "/app/server.py"]
