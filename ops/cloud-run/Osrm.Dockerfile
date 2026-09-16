FROM ghcr.io/project-osrm/osrm-backend:v5.27.1
# Dataset is mounted read-only from an immutable GCS release directory.
EXPOSE 8080
ENTRYPOINT ["osrm-routed"]
CMD ["--algorithm", "mld", "--port", "8080", "--threads", "1", "/snapshots/map.osrm"]
