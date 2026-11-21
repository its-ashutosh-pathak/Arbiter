-- Run this in your Supabase SQL Editor

-- 1. Create users table
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  upi_id TEXT,
  state TEXT DEFAULT 'IDLE',
  state_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create contracts table
CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  freelancer_phone TEXT REFERENCES users(phone),
  client_phone TEXT,
  client_name TEXT,
  description TEXT,
  amount INTEGER,
  revisions_allowed INTEGER,
  client_revision_count INTEGER DEFAULT 0,
  submission_status TEXT DEFAULT 'AWAITING_FREELANCER_SUBMISSION',
  payment_id TEXT UNIQUE, -- Idempotency: Ensures no duplicate Razorpay payments
  payment_link_id TEXT,
  last_submission_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'PENDING_AGREEMENT',
  freelancer_agreed BOOLEAN DEFAULT FALSE,
  client_agreed BOOLEAN DEFAULT FALSE,
  active_negotiation_amount INTEGER, -- Tracks pending settlement offers easily
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for fast phone lookups (Since webhook queries these constantly)
CREATE INDEX idx_contracts_freelancer_phone ON contracts(freelancer_phone);
CREATE INDEX idx_contracts_client_phone ON contracts(client_phone);

-- 3. Create events table
CREATE TABLE events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id TEXT REFERENCES contracts(id) ON DELETE CASCADE,
  actor TEXT,
  type TEXT,
  content TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create processed_messages table (Crucial for Twilio Webhook Idempotency)
CREATE TABLE processed_messages (
  message_sid TEXT PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
