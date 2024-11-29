CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    email TEXT,
    balance NUMERIC(10, 2) DEFAULT 0
);

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(telegram_id),
    amount NUMERIC(10, 2) NOT NULL,
    status TEXT NOT NULL, -- e.g., "pending", "successful"
    paystack_reference TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);