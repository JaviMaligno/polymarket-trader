FROM python:3.11.17-slim-bookworm

WORKDIR /app

# Install dependencies
COPY requirements.lock .
# ADD --checksum requires Dockerfile frontend >=1.6 (the PR uses Buildx/BuildKit).
ADD --checksum=sha256:fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70 https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl /tmp/pip-26.2.2-py3-none-any.whl
RUN PYTHONPATH=/tmp/pip-26.2.2-py3-none-any.whl python -m pip install --no-cache-dir --no-index --no-deps /tmp/pip-26.2.2-py3-none-any.whl \
    && rm /tmp/pip-26.2.2-py3-none-any.whl \
    && python -m pip install --no-cache-dir --require-hashes -r requirements.lock

# Copy application
COPY app/ ./app/

# Expose port
EXPOSE 8000

# Run server
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
