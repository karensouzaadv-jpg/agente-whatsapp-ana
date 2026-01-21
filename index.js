import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;

    if (message.type !== "text") {
      await sendWhatsAppText(from, "No momento, consigo responder apenas mensagens de texto.");
      return;
    }

    const userText = message.text.body;

    const system = `
Você é a Ana, assistente de um escritório de advocacia criminal.
Função: triagem inicial.
Regras:
- Não dê orientação jurídica.
- Não prometa resultados.
- Peça: nome, cidade/UF, o que aconteceu, data/horário, se há urgência (prisão/flagrante).
- Seja objetiva e respeitosa.
    `.trim();

    const ai = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.2",
      input: [
        { role: "system", content: system },
        { role: "user", content: userText }
      ]
    });

    const reply =
      ai.output_text ||
      "Entendi. Pode me informar seu nome e sua cidade/UF?";

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error(err);
  }
});

async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando");
});
