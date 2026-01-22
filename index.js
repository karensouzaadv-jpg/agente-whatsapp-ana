import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  PORT = 10000,
} = process.env;

/* ===============================
ROTA RAIZ (EVITA 404 NO RENDER)
================================ */
app.get("/", (req, res) => {
  res.status(200).send("OK - webhook online");
});

/* ===============================
SESSÕES EM MEMÓRIA
================================ */
const sessions = new Map();

/* ===============================
FUNÇÃO DE ESPERA
================================ */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ===============================
VERIFICAÇÃO WEBHOOK
================================ */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 GET /webhook (verificação)", { mode, token_ok: token === VERIFY_TOKEN });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso");
    return res.status(200).send(challenge);
  }

  console.log("❌ Falha na verificação do webhook");
  return res.sendStatus(403);
});

/* ===============================
RECEBIMENTO DE MENSAGENS
================================ */
app.post("/webhook", async (req, res) => {
  // Responde 200 rápido para a Meta
  res.sendStatus(200);

  try {
    console.log("📩 POST /webhook recebido:");
    console.dir(req.body, { depth: null });

    const msg = extractMessage(req.body);
    if (!msg) {
      console.log("ℹ️ Nenhuma mensagem de texto encontrada (ignorando).");
      return;
    }

    const { from, text } = msg;
    const lower = text.toLowerCase();
    const session = sessions.get(from) || {};

    console.log("👤 Mensagem de:", from, "| Texto:", text, "| Step atual:", session.step || "(novo)");

    /* ===== ABERTURA ===== */
    if (!session.step) {
      await send(from, "Olá. Agradecemos seu contato. Para iniciar seu atendimento, farei uma pergunta.");
      await send(
        from,
        "Para qual área você precisa de atendimento agora?\n\n" +
          "1️⃣ Criminal\n2️⃣ Família\n3️⃣ Cível\n4️⃣ Trabalhista\n5️⃣ Outro"
      );
      session.step = "area";
      sessions.set(from, session);
      return;
    }

    /* ===== ÁREA ===== */
    if (session.step === "area") {
      session.area = normalizeArea(text);
      sessions.set(from, session);

      if (session.area === "Criminal") {
        await send(
          from,
          "Para eu te orientar da forma mais adequada, me diga: a prisão aconteceu HOJE ou a pessoa JÁ ESTAVA PRESA?"
        );
        session.step = "prison_status";
        return;
      }

      session.step = "has_lawyer";
      await send(
        from,
        "Antes de seguirmos, preciso confirmar uma informação para organizar corretamente o atendimento: este caso já possui advogado(a) constituído(a) atualmente?"
      );
      return;
    }

    /* ===== CRIMINAL: STATUS DA PRISÃO ===== */
    if (session.step === "prison_status") {
      if (lower.includes("hoje")) {
        session.prison = "HOJE";
        session.step = "custody";
        await send(from, "Essa pessoa já passou pela audiência de custódia?");
        sessions.set(from, session);
        return;
      }

      session.prison = "JA_ESTAVA_PRESA";
      session.step = "has_lawyer";
      await send(
        from,
        "Antes de seguirmos, preciso confirmar uma informação para organizar corretamente o atendimento: este caso já possui advogado(a) constituído(a) atualmente?"
      );
      sessions.set(from, session);
      return;
    }

    /* ===== CRIMINAL: CUSTÓDIA ===== */
    if (session.step === "custody") {
      if (lower.includes("não") || lower.includes("nao")) {
        session.step = "call_permission";
        await send(from, "Nesse caso, o tempo é decisivo. Posso te ligar agora?");
        sessions.set(from, session);
        return;
      }

      session.step = "has_lawyer";
      await send(
        from,
        "Antes de seguirmos, preciso confirmar uma informação para organizar corretamente o atendimento: este caso já possui advogado(a) constituído(a) atualmente?"
      );
      sessions.set(from, session);
      return;
    }

    /* ===== PERMISSÃO PARA LIGAÇÃO ===== */
    if (session.step === "call_permission") {
      if (lower.includes("sim")) {
        await wait(30000);
        await send(from, "Tentei te ligar e a ligação não completou. Pode tentar me ligar aqui pelo WhatsApp agora?");
        sessions.delete(from);
        return;
      }
      sessions.delete(from);
      return;
    }

    /* ===== JÁ POSSUI ADVOGADO ===== */
    if (session.step === "has_lawyer") {
      if (lower.includes("não") || lower.includes("nao")) {
        session.step = "lead_data";
        await send(
          from,
          "Para que eu possa seguir com a análise inicial, por gentileza me informe seu nome completo, a cidade/UF e um breve resumo do caso."
        );
        sessions.set(from, session);
        return;
      }

      session.step = "lawyer_switch";
      await send(from, "Certo. Você está buscando uma troca de advogado ou apenas uma orientação pontual?");
      sessions.set(from, session);
      return;
    }

    /* ===== TROCA DE ADVOGADO ===== */
    if (session.step === "lawyer_switch") {
      if (lower.includes("troca")) {
        session.step = "process_data";
        await send(
          from,
          "Para avaliar a possibilidade de atuação, preciso analisar melhor o caso. " +
            "Informe seu nome completo, a cidade/UF e um breve resumo da situação atual.\n\n" +
            "Você possui o número do processo? Caso positivo, informe aqui. " +
            "Se não tiver, informe o CPF para consulta no Tribunal de Justiça."
        );
        sessions.set(from, session);
        return;
      }

      await send(
        from,
        "Para evitar qualquer conflito profissional, orientações paralelas não são realizadas quando já há advogado(a) constituído(a). " +
          "Recomendo que as tratativas sigam diretamente com o profissional responsável pelo caso."
      );
      sessions.delete(from);
      return;
    }

    /* ===== DADOS FINAIS ===== */
    if (session.step === "lead_data" || session.step === "process_data") {
      const hour = new Date().getHours();

      if (hour >= 8 && hour <= 19) {
        await send(from, "Estou finalizando um atendimento agora. Assim que concluir, retorno por ligação para conversarmos, tudo bem?");
      } else {
        await send(
          from,
          "Estou em horário de plantão no momento. Caso a ligação não seja atendida imediatamente, sua mensagem ficará registrada e retornarei o contato assim que possível."
        );
      }

      sessions.delete(from);
      return;
    }
  } catch (e) {
    console.error("🔥 Erro no POST /webhook:", e?.message);
  }
});

/* ===============================
FUNÇÕES AUXILIARES
================================ */
function extractMessage(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg?.text?.body) return null;
  return { from: msg.from, text: msg.text.body.trim() };
}

function normalizeArea(text) {
  return (
    {
      "1": "Criminal",
      "2": "Família",
      "3": "Cível",
      "4": "Trabalhista",
      "5": "Outro",
    }[text.trim()] || "Outro"
  );
}

async function send(to, body) {
  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("❌ ERRO ao enviar WhatsApp:", resp.status, data);
  } else {
    console.log("✅ Mensagem enviada para", to, "| id:", data?.messages?.[0]?.id);
  }

  return { ok: resp.ok, status: resp.status, data };
}

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
