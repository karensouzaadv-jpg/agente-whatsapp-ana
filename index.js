import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

/**
 * =========================
 * VARIÁVEIS DE AMBIENTE (Render)
 * =========================
 * VERIFY_TOKEN=um_texto_qualquer
 * WHATSAPP_TOKEN=token_do_whatsapp_cloud_api
 * PHONE_NUMBER_ID=seu_phone_number_id (ex: 9718...)
 * OPENAI_API_KEY=sua_chave_openai
 *
 * NOTION_TOKEN=secret_xxx  (Notion integration token)
 * NOTION_DB_ID=xxxxxxxxxxxxxxxxxxxxxx (database id do CRM)
 */

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  OPENAI_API_KEY,
  NOTION_TOKEN,
  NOTION_DB_ID,
  PORT = 10000,
} = process.env;

// ✅ Regras do seu agente (coloque aqui e ajuste quando quiser)
const SYSTEM_PROMPT = `
Você é um advogado do escritório Karen Alves Advocacia e conversa pelo WhatsApp.
Seu tom: formal, acolhedor, humano, objetivo e profissional.
Você NÃO deve se apresentar como secretária, atendente, recepção ou “vou chamar um advogado”.
Fale como advogado do escritório, sem inventar nome específico.

OBJETIVO:
- Captar lead, qualificar e fazer triagem inicial.
- Tirar dúvidas simples e orientar próximos passos.
- Coletar informações essenciais e encaminhar para consulta/atendimento humano quando necessário.
- Informar áreas atendidas e lista básica de documentos.
- Pode solicitar envio de documentos (sem prometer análise completa pelo WhatsApp, diga que após a análise, ainda hoje entrará em contato por ligação).

REGRAS PROIBIDAS (NUNCA FAÇA):
- Não informar preços de honorários/“quanto custa o processo”.
- Não prometer resultado, “causa ganha”, “você vai ganhar”, nem dar expectativa de ganhos.
- Não dar orientação jurídica, nem estratégia detalhada, nem “petições”.
- Não falar sobre processo específico como se tivesse acesso aos autos.
- Não garantir prazos, decisões, ou afirmar que “o processo é ganho”.

GATILHOS DE URGÊNCIA:
Se o cliente falar “prisão”, “custódia”, “flagrante”, “audiência hoje”, “audiência”, “delegacia”, “mandado”, “urgente”:
- Responda com máxima prioridade e peça local/cidade, horário, nome completo, e se há detido/onde.
- pergunte se podemos ligar.
- Sem prometer resultado.

O QUE VOCÊ DEVE COLETAR NA TRIAGEM:
- Nome do cliente
- Cidade/UF
- Área (Criminal, Cível, Trabalhista, Família, Previdenciário, etc.)
- Resumo do problema (curto)
- Se há urgência (sim/não) e qual

RESPOSTA PADRÃO:
- Use mensagens curtas, claras, sem juridiquês pesado.
- Sempre finalize com UMA pergunta objetiva para avançar o atendimento.
`;

/**
 * =========================
 * 1) Verificação do Webhook (Meta)
 * =========================
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * =========================
 * 2) Receber mensagens (Meta -> seu webhook)
 * =========================
 */
app.post("/webhook", async (req, res) => {
  try {
    // Sempre responda 200 rápido pra Meta não reenviar
    res.sendStatus(200);

    const incoming = extractIncomingMessage(req.body);
    if (!incoming) return;

    const { from, text } = incoming;

    // 2.1) Gerar resposta com OpenAI
    const aiReply = await generateAIReply({
      userText: text,
      userPhone: from,
    });

    // 2.2) Enviar resposta para WhatsApp
    await sendWhatsAppText({ to: from, body: aiReply });

    // 2.3) Salvar no Notion (CRM)
    await upsertLeadInNotion({
      phone: from,
      lastMessage: text,
      lastReply: aiReply,
    });
  } catch (err) {
    console.error("Erro no webhook:", err?.message || err);
  }
});

/**
 * =========================
 * Util: extrair mensagem do payload do WhatsApp
 * =========================
 */
function extractIncomingMessage(body) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  const message = value?.messages?.[0];
  if (!message) return null;

  const from = message.from; // telefone do cliente (ex: 5562...)
  const text = message?.text?.body;

  // Ignora coisas que não sejam texto (imagem, audio etc.) por enquanto
  if (!from || !text) return null;

  return { from, text };
}

/**
 * =========================
 * 3) OpenAI: gerar resposta com regras
 * =========================
 */
async function generateAIReply({ userText, userPhone }) {
  if (!OPENAI_API_KEY) {
    return "No momento estamos com instabilidade técnica. Pode me dizer seu nome e sua cidade/UF para eu dar sequência?";
  }

  // Use um modelo compatível com chat/completions-style
  // (Se você já usa Responses API, posso adaptar depois)
  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Telefone do cliente: ${userPhone}\nMensagem: ${userText}`,
      },
    ],
    temperature: 0.4,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const t = await safeText(resp);
    console.error("OpenAI erro:", resp.status, t);
    return "Entendi. Para eu te orientar corretamente na triagem inicial, pode me dizer seu nome e sua cidade/UF?";
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim();

  // fallback
  return (
    content ||
    "Entendi. Pode me dizer seu nome e sua cidade/UF para eu seguir com a triagem inicial?"
  );
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * =========================
 * 4) WhatsApp Cloud API: enviar texto
 * =========================
 */
async function sendWhatsAppText({ to, body }) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltando WHATSAPP_TOKEN ou PHONE_NUMBER_ID");
    return;
  }

  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Erro ao enviar WhatsApp:", resp.status, data);
  }
}

/**
 * =========================
 * 5) Notion CRM: salvar lead (simples)
 * =========================
 * Pré-requisito: seu Notion DB precisa ter estas propriedades:
 * - Nome do Cliente (title)
 * - Telefone (rich_text ou phone)
 * - Área (select)  [opcional]
 * - Última Mensagem (rich_text)
 * - Última Resposta (rich_text)
 * - Status (select) ex: Novo / Em atendimento / Encerrado
 */
async function upsertLeadInNotion({ phone, lastMessage, lastReply }) {
  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    // Se você ainda não configurou Notion, não quebra o fluxo
    return;
  }

  // 5.1) Tentar encontrar lead existente pelo telefone
  const existing = await notionFindByPhone(phone);

  if (existing?.id) {
    await notionUpdate(existing.id, { phone, lastMessage, lastReply });
  } else {
    await notionCreate({ phone, lastMessage, lastReply });
  }
}

async function notionFindByPhone(phone) {
  const resp = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify({
      filter: {
        property: "Telefone",
        rich_text: { equals: phone },
      },
      page_size: 1,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Notion query erro:", resp.status, data);
    return null;
  }

  return data?.results?.[0] || null;
}

async function notionCreate({ phone, lastMessage, lastReply }) {
  const resp = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_ID },
      properties: {
        "Nome do Cliente": { title: [{ text: { content: "Novo lead" } }] },
        Telefone: { rich_text: [{ text: { content: phone } }] },
        Status: { select: { name: "Novo" } },
        "Última Mensagem": { rich_text: [{ text: { content: lastMessage } }] },
        "Última Resposta": { rich_text: [{ text: { content: lastReply } }] },
      },
    }),
  });

  const data = await resp.json();
  if (!resp.ok) console.error("Notion create erro:", resp.status, data);
}

async function notionUpdate(pageId, { lastMessage, lastReply }) {
  const resp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(),
    body: JSON.stringify({
      properties: {
        "Última Mensagem": { rich_text: [{ text: { content: lastMessage } }] },
        "Última Resposta": { rich_text: [{ text: { content: lastReply } }] },
      },
    }),
  });

  const data = await resp.json();
  if (!resp.ok) console.error("Notion update erro:", resp.status, data);
}

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

app.get("/", (_, res) => res.status(200).send("OK"));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
