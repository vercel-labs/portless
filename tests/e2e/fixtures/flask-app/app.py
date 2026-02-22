import os

from flask import Flask

app = Flask(__name__)


@app.route("/")
def root():
    return "<h1>hello from flask</h1>"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port)
