FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir osmium==4.3.0 'psycopg[binary]==3.2.9'
COPY import.py /import.py
ENTRYPOINT ["python", "/import.py"]
