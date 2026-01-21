import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "meu_token_teste";

/**
 * ROTA RAIZ (IMPORTANTE)
 * Evita o erro "Não pode obter /"
 */
app.get("/", (req, res) => {
  res.send("Webhook WhatsApp ativo 🚀");
});

/**
 * VERIFICAÇÃO DO WEBHOOK (Meta)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

/**
 * RECEBER MENSAGENS DO WHATSAPP
 */
app.post("/webhook", (req, res) => {
  console.log("Mensagem recebida:");
  console.dir(req.body, { depth: null });

  res.sendStatus(200);
});

/**
 * INICIAR SERVIDOR
 */
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
