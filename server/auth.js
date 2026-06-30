const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "change-me-in-production";
const USER   = process.env.DASHBOARD_USER || "admin";
const PASS   = process.env.DASHBOARD_PASSWORD || "password";

function createToken() {
  return jwt.sign({ user: USER }, SECRET, { expiresIn: "7d" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// Supports Bearer header or ?token= query param (needed for EventSource which can't set headers)
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  const headerToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const queryToken  = req.query.token;
  const token = headerToken || queryToken;

  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function loginHandler(req, res) {
  const { username, password } = req.body;
  if (username !== USER || password !== PASS) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json({ token: createToken() });
}

module.exports = { authMiddleware, loginHandler };
