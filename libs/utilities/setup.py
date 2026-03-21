from setuptools import setup, find_packages

setup(
    name="utilities",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        # Core data processing
        "pandas>=1.5.0",
        "numpy>=1.20.0",
        # HTTP requests
        "requests>=2.28.0",
        # Binary data parsing
        "pyarrow>=10.0.0",
        # Machine learning (for ai_utils)
        "xgboost>=1.7.0",
        "scikit-learn>=1.0.0",
        # Statistical analysis (for race_utils)
        "statsmodels>=0.13.0",
        # Environment variables
        "python-dotenv>=0.19.0",
        # Date/time handling (for datetime_utils)
        "pytz>=2022.1",
        "python-dateutil>=2.8.0",
        # InfluxDB client (for api_utils)
        "influxdb-client>=1.36.0",
    ],
    author="Chad Turner",
    author_email="thechadturner@gmail.com",
    description="A utility library for mathematical calculations.",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    url="https://github.com/thechadturner/utilities",
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
    python_requires='>=3.6',
)