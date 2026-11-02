FROM python:3.12-slim

# ASC 日志里的 date 不带时区，按服务器本地时区解释，需与使用者一致
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    CAN_REPLAY_MULTI_USER=1 \
    CAN_REPLAY_DATA=/data \
    CAN_REPLAY_AUTO_RELOAD=0
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .

VOLUME /data
EXPOSE 8000
CMD ["python", "run_server.py"]
