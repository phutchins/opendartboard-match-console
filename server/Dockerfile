FROM python:3.12-alpine

WORKDIR /app
COPY app.py /app/app.py

ENV DB_PATH=/data/stats.db
ENV PORT=8091
EXPOSE 8091

CMD ["python", "-u", "/app/app.py"]
