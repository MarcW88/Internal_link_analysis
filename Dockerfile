FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/app \
    MPLCONFIGDIR=/tmp/matplotlib \
    XDG_CACHE_HOME=/tmp \
    STREAMLIT_CONFIG_DIR=/tmp/.streamlit \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    STREAMLIT_SERVER_HEADLESS=true

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

COPY . /app

RUN mkdir -p /tmp/.streamlit /tmp/matplotlib && \
    printf '[browser]\ngatherUsageStats = false\n\n[server]\nheadless = true\naddress = "0.0.0.0"\nport = 7860\nenableCORS = false\nenableXsrfProtection = false\nmaxUploadSize = 200\n' > /tmp/.streamlit/config.toml

EXPOSE 7860

CMD streamlit run app.py --server.address=0.0.0.0 --server.port=${PORT:-7860} --server.enableCORS=false --server.enableXsrfProtection=false --server.maxUploadSize=200
