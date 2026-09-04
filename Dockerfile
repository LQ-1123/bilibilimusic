FROM python:3.13-slim

WORKDIR /srv/app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV BM_DATA_DIR=/srv/data \
    BM_HOST=0.0.0.0 \
    BM_PORT=8000

VOLUME ["/srv/data"]
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
