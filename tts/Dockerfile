FROM python:3.12-slim
RUN pip install --no-cache-dir kokoro-onnx==0.6.1 soundfile==0.14.0 onnxruntime==1.29.0
# Download the open-source Kokoro model (Apache-2.0) at build time
RUN mkdir /models && python -c "import urllib.request as u; b='https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'; [u.urlretrieve(b+f, '/models/'+f) for f in ('kokoro-v1.0.onnx','voices-v1.0.bin')]"
WORKDIR /app
COPY server.py bench.py ./
RUN useradd -m tts
USER tts
EXPOSE 8000
CMD ["python", "server.py"]
