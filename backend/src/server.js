const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// HOME
app.get("/", (req, res) => {
  res.json({
    name: "WAM WhatsApp Memory API",
    status: "running",
    version: "1.0.0"
  });
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// DATABASE CHECK
app.get("/api/health/db", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "success", database: "connected" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET CONTACTS
app.get("/api/contacts", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM contacts ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADD CONTACT
app.post("/api/contacts", async (req, res) => {
  try {
    const { user_id, name, phone } = req.body;

    const result = await pool.query(
      `INSERT INTO contacts (user_id, name, phone)
       VALUES ($1, $2, $3) RETURNING *`,
      [user_id, name, phone]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET MESSAGES
app.get("/api/contacts/:id/messages", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM messages
       WHERE contact_id = $1
       ORDER BY sent_at ASC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET MEMORIES
app.get("/api/contacts/:id/memories", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM memories
       WHERE contact_id = $1
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADD MEMORY
app.post("/api/contacts/:id/memories", async (req, res) => {
  try {
    const { title, content, category } = req.body;

    const result = await pool.query(
      `INSERT INTO memories
       (contact_id, title, content, category)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, title, content, category]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SEARCH MESSAGES
app.get("/api/search", async (req, res) => {
  try {
    const { q, contact_id } = req.query;

    if (!q) {
      return res.status(400).json({ error: "Search query required" });
    }

    const result = await pool.query(
      `SELECT * FROM messages
       WHERE content ILIKE $1
       AND ($2::uuid IS NULL OR contact_id = $2)
       ORDER BY sent_at DESC
       LIMIT 100`,
      [`%${q}%`, contact_id || null]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WHATSAPP CHAT IMPORT
app.post(
  "/api/import",
  upload.single("file"),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const { contact_id } = req.body;

      if (!req.file || !contact_id) {
        return res.status(400).json({
          error: "File and contact_id required"
        });
      }

      const chat = req.file.buffer.toString("utf8");

      const lines = chat.split(/\r?\n/);

      const messages = [];

      const regex =
        /^(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s?[APap][Mm])?)\s*[-–]\s*([^:]+):\s*(.*)$/;

      for (const line of lines) {
        const match = line.match(regex);

        if (match) {
          messages.push({
            sent_at: new Date(
              `${match[1]} ${match[2]}`
            ),
            sender: match[3].trim(),
            content: match[4].trim()
          });
        }
      }

      if (messages.length === 0) {
        return res.status(400).json({
          error: "No WhatsApp messages detected. Check export format."
        });
      }

      await client.query("BEGIN");

      const job = await client.query(
        `INSERT INTO import_jobs
         (contact_id, filename, status, total_messages)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          contact_id,
          req.file.originalname,
          "processing",
          messages.length
        ]
      );

      let imported = 0;
      let duplicates = 0;

      for (const msg of messages) {
        const hash = crypto
          .createHash("sha256")
          .update(
            `${contact_id}|${msg.sent_at.toISOString()}|${msg.sender}|${msg.content}`
          )
          .digest("hex");

        const exists = await client.query(
          `SELECT id FROM messages
           WHERE contact_id = $1 AND content_hash = $2
           LIMIT 1`,
          [contact_id, hash]
        );

        if (exists.rowCount > 0) {
          duplicates++;
          continue;
        }

        await client.query(
          `INSERT INTO messages
           (contact_id, sender, sent_at, content, content_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            contact_id,
            msg.sender,
            msg.sent_at,
            msg.content,
            hash
          ]
        );

        imported++;
      }

      await client.query(
        `UPDATE import_jobs
         SET status = 'completed',
             new_messages = $1,
             duplicates = $2,
             finished_at = NOW()
         WHERE id = $3`,
        [imported, duplicates, job.rows[0].id]
      );

      await client.query("COMMIT");

      res.json({
        status: "success",
        total_messages: messages.length,
        imported,
        duplicates
      });

    } catch (error) {
      await client.query("ROLLBACK");

      res.status(500).json({
        error: error.message
      });

    } finally {
      client.release();
    }
  }
);

// API NOT FOUND
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found"
  });
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: "Internal Server Error"
  });
});

// START SERVER
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

// SHUTDOWN
async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
