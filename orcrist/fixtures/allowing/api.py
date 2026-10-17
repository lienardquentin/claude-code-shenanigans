def post(url: str, data: bytes):
    info = encode(data)
    return send(url, info)
