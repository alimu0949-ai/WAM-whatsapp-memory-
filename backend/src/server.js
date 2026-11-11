const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    })
  : null;

app.use(express.json({ limit: "1mb" }));

// Home Route
app.get("/", (req, res) => {
  res.json({
    name: "WAM WhatsApp Memory API",
    status: "running",
    message: "Server is working successfully"
  });
});

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// Database Connection Check
app.get("/api/health/db", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      status: "error",
      message: "DATABASE_URL not configured"
    });
  }

  try {
    await pool.query("SELECT 1");

    res.json({
      status: "success",
      database: "connected"
    });

  } catch (error) {
    console.error(error.message);

    res.status(503).json({
      status: "error",
      database: "disconnected"
    });
  }
});

// API Routes
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found"
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(err.message);

  res.status(500).json({
    error: "Internal Server Error"
  });
});

// Start Server
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful Shutdown
async function shutdown() {
  server.close(async () => {
    if (pool) {
      await pool.end();
    }
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
