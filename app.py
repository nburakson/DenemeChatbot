"""
DenemeChatbot – Document upload, parsing, and Q&A chatbot.

Supported document types: PDF, DOCX, TXT
Q&A strategy: TF-IDF retrieval over document chunks
"""

import os
import uuid
import re
import io

from flask import Flask, request, jsonify, render_template
from werkzeug.utils import secure_filename

# PDF parsing
import PyPDF2

# DOCX parsing
from docx import Document as DocxDocument

# TF-IDF retrieval
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np

# ---------------------------------------------------------------------------
# App configuration
# ---------------------------------------------------------------------------

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), "uploads")
ALLOWED_EXTENSIONS = {"pdf", "docx", "txt"}
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB per file
CHUNK_SIZE = 400          # approximate characters per chunk
CHUNK_OVERLAP = 80        # overlap between consecutive chunks
TOP_K = 3                 # number of chunks to return per query

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# ---------------------------------------------------------------------------
# In-memory document store
# ---------------------------------------------------------------------------
# documents: { doc_id: { "name": str, "chunks": [str] } }
documents: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------

def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def extract_text(file_stream, filename: str) -> str:
    """Return the full plain-text content of an uploaded file."""
    ext = filename.rsplit(".", 1)[1].lower()
    if ext == "pdf":
        reader = PyPDF2.PdfReader(file_stream)
        parts = []
        for page in reader.pages:
            text = page.extract_text()
            if text:
                parts.append(text)
        return "\n".join(parts)
    elif ext == "docx":
        doc = DocxDocument(file_stream)
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    else:  # txt
        raw = file_stream.read()
        for enc in ("utf-8", "latin-1", "cp1252"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", errors="replace")


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split *text* into overlapping chunks."""
    # Normalise whitespace
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        chunks.append(text[start:end].strip())
        if end == len(text):
            break
        start += size - overlap
    return [c for c in chunks if c]


def retrieve_relevant_chunks(query: str, top_k: int = TOP_K) -> list[dict]:
    """
    Find the *top_k* most relevant chunks across all uploaded documents
    using TF-IDF + cosine similarity.

    Returns a list of dicts: {"doc_name": str, "chunk": str, "score": float}
    """
    all_chunks: list[str] = []
    chunk_meta: list[dict] = []

    for doc_id, doc in documents.items():
        for chunk in doc["chunks"]:
            all_chunks.append(chunk)
            chunk_meta.append({"doc_name": doc["name"], "doc_id": doc_id})

    if not all_chunks:
        return []

    corpus = all_chunks + [query]
    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2))
    tfidf_matrix = vectorizer.fit_transform(corpus)

    query_vec = tfidf_matrix[-1]
    doc_vecs = tfidf_matrix[:-1]

    similarities = cosine_similarity(query_vec, doc_vecs).flatten()
    top_indices = np.argsort(similarities)[::-1][:top_k]

    results = []
    for idx in top_indices:
        score = float(similarities[idx])
        if score > 0:
            results.append({
                "doc_name": chunk_meta[idx]["doc_name"],
                "chunk": all_chunks[idx],
                "score": round(score, 4),
            })
    return results


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/documents", methods=["GET"])
def list_documents():
    return jsonify([
        {"id": doc_id, "name": doc["name"], "chunks": len(doc["chunks"])}
        for doc_id, doc in documents.items()
    ])


@app.route("/upload", methods=["POST"])
def upload_document():
    if "file" not in request.files:
        return jsonify({"error": "No file part in the request."}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected."}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": f"Unsupported file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"}), 400

    filename = secure_filename(file.filename)
    file_stream = io.BytesIO(file.read())

    try:
        text = extract_text(file_stream, filename)
    except Exception as exc:
        return jsonify({"error": f"Failed to parse document: {exc}"}), 422

    if not text.strip():
        return jsonify({"error": "Document appears to be empty or could not be parsed."}), 422

    chunks = chunk_text(text)
    doc_id = str(uuid.uuid4())
    documents[doc_id] = {"name": filename, "chunks": chunks}

    return jsonify({
        "id": doc_id,
        "name": filename,
        "chunks": len(chunks),
        "message": f"Document '{filename}' uploaded and indexed successfully.",
    }), 201


@app.route("/documents/<doc_id>", methods=["DELETE"])
def delete_document(doc_id: str):
    if doc_id not in documents:
        return jsonify({"error": "Document not found."}), 404
    name = documents.pop(doc_id)["name"]
    return jsonify({"message": f"Document '{name}' removed."})


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    query = (data.get("message") or "").strip()

    if not query:
        return jsonify({"error": "Message cannot be empty."}), 400

    if not documents:
        return jsonify({
            "answer": "No documents have been uploaded yet. Please upload a document first.",
            "sources": [],
        })

    results = retrieve_relevant_chunks(query)

    if not results:
        return jsonify({
            "answer": "I couldn't find relevant information in the uploaded documents for your question.",
            "sources": [],
        })

    # Build the answer from the top-ranked chunks
    answer_parts = []
    sources = []
    for i, r in enumerate(results, 1):
        answer_parts.append(f"[{i}] {r['chunk']}")
        sources.append({"doc_name": r["doc_name"], "score": r["score"]})

    answer = (
        "Based on the uploaded documents, here is what I found:\n\n"
        + "\n\n".join(answer_parts)
    )

    return jsonify({"answer": answer, "sources": sources})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(debug=debug, port=5000)
