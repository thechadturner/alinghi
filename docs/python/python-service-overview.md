# FastAPI Python Wrapper for External Scripts

This FastAPI project provides an interface to execute and interact with external Python scripts stored in a structured folder. It mirrors the functionality of a Node.js wrapper using child processes.

## 🚀 Features

- Prewarms Python on server startup
- Executes arbitrary Python scripts in background
- Fetches data from Python scripts and parses results
- Scalable and easy to plug in new scripts

## 🗂 File Structure

```text
your_project/
├── app/
│   └── main.py               # FastAPI application logic
├── scripts/
│   └── <class_name>/
│       └── <script_name>.py  # Python scripts to be executed
├── requirements.txt          # Dependencies
└── README.md                 # Project overview
