FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS osrm
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libboost-program-options1.74.0 libboost-filesystem1.74.0 libboost-iostreams1.74.0 libboost-thread1.74.0 liblua5.4-0 libexpat1 libbz2-1.0 libzstd1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=osrm /usr/local/bin/osrm-* /usr/local/bin/
COPY --from=osrm /usr/local/lib/ /usr/local/lib/
COPY --from=osrm /opt/ /opt/
RUN ldconfig && osrm-extract --version && osrm-partition --version && osrm-customize --version && osrm-routed --version
RUN pip install --no-cache-dir osmium==4.3.0 shapely==2.0.7 google-cloud-storage==3.4.0 google-auth==2.40.3 requests==2.32.5
WORKDIR /job
COPY ops/cloud-run/*.py ./
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/job/update.py"]
