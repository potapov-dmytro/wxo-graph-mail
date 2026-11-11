/**
 * Host server for the wxO mail agent.
 *
 * 1. Signs the user in with Entra ID (auth code flow + PKCE, MSAL Node).
 *    The Entra access token stays server-side; the browser never sees it.
 * 2. /createJWT returns the wxO secure-embed JWT. Its user_payload carries the
 *    Entra access token as sso_token, encrypted with IBM's public key.
 * 3. /config gives the page the non-secret wxO embed settings.
 *
 * Sample only: in-memory sessions and token cache, HTTP on localhost.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const jwt = require("jsonwebtoken");
const NodeRSA = require("node-rsa");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const msal = require("@azure/msal-node");

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k} in .env`);
  return v;
};

const TENANT_ID = env("TENANT_ID");
const CLIENT_ID = env("CLIENT_ID");
const REDIRECT_URI = env("REDIRECT_URI");
const PORT = Number(process.env.PORT || 5555);
const API_SCOPE = `api://${CLIENT_ID}/access_as_user`;
const WXO_MAX_JWT_SECONDS = 7100; // IBM's documented maximum

const keyPath = (f) => path.join(__dirname, "keys", f);
const PRIVATE_KEY = fs.readFileSync(keyPath("jwtRS256.key"));
const IBM_PUBLIC_KEY = fs.readFileSync(keyPath("ibmPublic.key.pub"));

const cca = new msal.ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientSecret: env("CLIENT_SECRET"),
  },
});
const crypto = new msal.CryptoProvider();

// Validates that the Entra token is the one OBO needs: v2, issued for our API.
const JWKS = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`)
);
async function verifyEntraToken(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    audience: CLIENT_ID,
  });
  if (!String(payload.scp || "").split(" ").includes("access_as_user")) {
    throw new Error("Token lacks access_as_user scope");
  }
  return payload;
}

const app = express();
app.use(
  session({
    secret: env("SESSION_SECRET"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false }, // secure: true behind HTTPS
  })
);

// ---- Sign in ----
app.get("/auth/login", async (req, res, next) => {
  try {
    const { verifier, challenge } = await crypto.generatePkceCodes();
    req.session.pkceVerifier = verifier;
    const url = await cca.getAuthCodeUrl({
      scopes: [API_SCOPE],
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      prompt: "select_account",
    });
    res.redirect(url);
  } catch (e) {
    next(e);
  }
});

app.get("/auth/redirect", async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`${req.query.error}: ${req.query.error_description}`);
    }
    const result = await cca.acquireTokenByCode({
      code: req.query.code,
      scopes: [API_SCOPE],
      redirectUri: REDIRECT_URI,
      codeVerifier: req.session.pkceVerifier,
    });
    req.session.homeAccountId = result.account.homeAccountId;
    req.session.userName = result.account.name || result.account.username;
    delete req.session.pkceVerifier;
    res.redirect("/");
  } catch (e) {
    next(e);
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() =>
    res.redirect(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(
        `http://localhost:${PORT}/`
      )}`
    )
  );
});

app.get("/auth/me", (req, res) => {
  res.json({ signedIn: Boolean(req.session.homeAccountId), name: req.session.userName || null });
});

// ---- Entra token for the signed-in user (silent refresh via MSAL cache) ----
async function getEntraToken(req) {
  const account = await cca.getTokenCache().getAccountByHomeId(req.session.homeAccountId);
  if (!account) throw Object.assign(new Error("Session expired"), { status: 401 });
  const result = await cca.acquireTokenSilent({ account, scopes: [API_SCOPE] });
  return result.accessToken;
}

// ---- wxO secure-embed JWT ----
app.get("/createJWT", async (req, res, next) => {
  try {
    if (!req.session.homeAccountId) return res.status(401).send("Sign in first");

    const ssoToken = await getEntraToken(req);
    const claims = await verifyEntraToken(ssoToken);

    // Cap wxO JWT life to the Entra token's remaining life, minus a minute.
    const remaining = claims.exp - Math.floor(Date.now() / 1000) - 60;
    const expiresIn = Math.max(60, Math.min(WXO_MAX_JWT_SECONDS, remaining));

    const userPayload = {
      name: claims.name || req.session.userName,
      custom_user_id: claims.oid,
      sso_token: ssoToken,
    };
    const encrypted = new NodeRSA(IBM_PUBLIC_KEY).encrypt(
      Buffer.from(JSON.stringify(userPayload), "utf-8"),
      "base64"
    );

    const wxoJwt = jwt.sign(
      {
        sub: claims.oid, // stable Entra object ID
        user_payload: encrypted,
        context: { name: claims.name, upn: claims.preferred_username },
      },
      PRIVATE_KEY,
      { algorithm: "RS256", expiresIn }
    );
    res.type("text/plain").send(wxoJwt);
  } catch (e) {
    next(e);
  }
});

// ---- Non-secret embed settings for the page ----
app.get("/config", (req, res) => {
  res.json({
    orchestrationID: env("WXO_ORCHESTRATION_ID"),
    hostURL: env("WXO_HOST_URL"),
    agentId: env("WXO_AGENT_ID"),
    agentEnvironmentId: env("WXO_AGENT_ENVIRONMENT_ID"),
    deploymentPlatform: process.env.WXO_DEPLOYMENT_PLATFORM || undefined,
    crn: process.env.WXO_CRN || undefined,
  });
});

app.use(express.static(path.join(__dirname, "static")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).send(err.message || "Server error");
});

app.listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
