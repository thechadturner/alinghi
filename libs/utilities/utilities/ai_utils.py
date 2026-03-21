import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_squared_error
import numpy as np
import pandas as pd
from .logging_utils import log_warning, log_info
from typing import List, Optional

# Function to train XGBoost model for a sailing mode
def train_XGBoost(data: pd.DataFrame, features: List[str], target: str) -> Optional[xgb.XGBRegressor]:
    """Train XGBoost model for a specific sailing mode"""
    if len(data) < 100:
        log_warning(f"Insufficient data: {len(data)} seconds (need >=100)")
        return None
    
    log_info(f"Training XGBoost model with {len(data)} seconds of data...")
    
    # Check if all required columns exist
    missing_cols = [col for col in features + [target] if col not in data.columns]
    if missing_cols:
        log_warning(f"Missing columns: {missing_cols}")
        return None
    
    X = data[features].copy()
    y = data[target].copy()
    
    # Remove any rows with NaN values
    mask = ~(X.isna().any(axis=1) | y.isna())
    X = X[mask]
    y = y[mask]
    
    if len(X) < 100:
        log_warning(f"Insufficient clean data: {len(X)} rows after removing NaN (minimum 100 required)")
        return None
    
    # Split the data
    if len(X) > 100:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    else:
        # Use all data for training if dataset is small
        X_train, X_test, y_train, y_test = X, X, y, y
    
    # Train XGBoost model
    model = xgb.XGBRegressor(
        n_estimators=100,
        max_depth=6,
        learning_rate=0.1,
        random_state=42
    )
    
    model.fit(X_train, y_train)
    
    # Make predictions and calculate RMSE
    y_pred = model.predict(X_test)
    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    
    log_info(f"  Model RMSE: {rmse:.3f}")
    log_info(f"  Feature importance: {dict(zip(features, model.feature_importances_))}")
    
    return model