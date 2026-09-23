FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN python build_fonts.py && python -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR()"
ENV PYTHONUNBUFFERED=1 WORK_DIR=/tmp/cribcuts
CMD ["sh", "-c", "uvicorn app.server:app --host 0.0.0.0 --port ${PORT:-10000}"]
