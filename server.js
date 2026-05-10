require("dotenv").config();

const express = require("express");
const cors = require("cors");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const { Client, LocalAuth } = require("whatsapp-web.js");

const serviceAccount = JSON.parse(
  Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    "base64"
  ).toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const URL_SITE = "https://codestudio-464a0.web.app/cliente.html";

const bots = {};
const qrs = {};
const statusBots = {};

function normalizarNumero(numero) {
  if (!numero) return "";

  let num = String(numero)
    .replace("@c.us", "")
    .replace(/\D/g, "");

  if (!num.startsWith("55")) {
    num = "55" + num;
  }

  return num;
}

async function buscarConfigBot(empresaId) {
  try {
    const doc = await db
      .collection("empresas")
      .doc(empresaId)
      .collection("bot")
      .doc("config")
      .get();

    if (!doc.exists) {
      return {
        ativo: true,
        avisarKanban: true,
        mensagemBoasVindas: "Olá! Seja bem-vindo(a) 😊",
        mensagemPedidoAceito: "✅ Seu pedido foi aceito!",
        mensagemSaiuEntrega: "🚗 Seu pedido saiu para entrega!",
        mensagemPedidoFinalizado: "✅ Pedido finalizado. Obrigado!",
        mensagemPedidoCancelado: "❌ Pedido cancelado."
      };
    }

    return doc.data();

  } catch (erro) {
    console.log("Erro buscarConfigBot:", erro.message);

    return {
      ativo: true
    };
  }
}

async function salvarClienteBot(empresaId, message) {
  const numero = normalizarNumero(message.from);
  const nome = message._data?.notifyName || "Cliente WhatsApp";

  await db
    .collection("empresas")
    .doc(empresaId)
    .collection("clientes_bot")
    .doc(numero)
    .set({
      nome,
      whatsapp: numero,
      ultimoContato: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

  return { numero, nome };
}

async function enviarMensagemEmpresa(empresaId, numero, mensagem) {
  try {
    const bot = bots[empresaId];

    if (!bot) {
      console.log("Bot não encontrado:", empresaId);
      return false;
    }

    if (statusBots[empresaId] !== "conectado") {
      console.log("Bot não conectado:", empresaId);
      return false;
    }

    const numeroFinal = `${normalizarNumero(numero)}@c.us`;

    await bot.sendMessage(numeroFinal, mensagem);

    console.log("Mensagem enviada:", empresaId, numero);

    return true;

  } catch (erro) {
    console.log("Erro enviarMensagemEmpresa:", erro.message);
    return false;
  }
}

function iniciarBotEmpresa(empresaId) {
  if (!empresaId) {
    throw new Error("empresaId obrigatório");
  }

  if (bots[empresaId]) {
    return {
      empresaId,
      status: statusBots[empresaId]
    };
  }

  statusBots[empresaId] = "iniciando";

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: empresaId,
      dataPath: "./sessions"
    }),

    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    }
  });

  client.on("qr", async qr => {
    console.log("QR GERADO:", empresaId);

    qrcodeTerminal.generate(qr, {
      small: true
    });

    qrs[empresaId] = await QRCode.toDataURL(qr);

    statusBots[empresaId] = "aguardando_qr";
  });

  client.on("authenticated", () => {
    console.log("BOT AUTENTICADO:", empresaId);

    statusBots[empresaId] = "autenticado";
  });

  client.on("ready", () => {
    console.log("BOT ONLINE:", empresaId);

    qrs[empresaId] = null;

    statusBots[empresaId] = "conectado";
  });

  client.on("auth_failure", erro => {
    console.log("ERRO AUTENTICAÇÃO:", empresaId, erro);

    statusBots[empresaId] = "erro_autenticacao";
  });

  client.on("disconnected", motivo => {
    console.log("BOT DESCONECTADO:", empresaId, motivo);

    statusBots[empresaId] = "desconectado";

    delete bots[empresaId];
    delete qrs[empresaId];

    setTimeout(() => {
      console.log("Tentando reconectar:", empresaId);

      iniciarBotEmpresa(empresaId);

    }, 10000);
  });

  client.on("message", async message => {
    try {
      if (message.fromMe) return;

      if (message.from.includes("@g.us")) return;

      const config = await buscarConfigBot(empresaId);

      if (config.ativo === false) {
        console.log("Bot inativo:", empresaId);
        return;
      }

      const { numero, nome } = await salvarClienteBot(
        empresaId,
        message
      );

      const linkCardapio =
`${URL_SITE}?empresa=${empresaId}&wpp=${numero}`;

      const mensagem =
`${config.mensagemBoasVindas || `Olá ${nome}! 😊`}

📲 Acesse nosso cardápio:

${linkCardapio}`;

      await message.reply(mensagem);

      console.log("Mensagem boas-vindas enviada");

    } catch (erro) {
      console.log("Erro mensagem recebida:", erro.message);
    }
  });

  bots[empresaId] = client;

  client.initialize();

  return {
    empresaId,
    status: "iniciado"
  };
}

async function monitorarPedidosEmpresa(empresaId) {
  console.log("Monitorando pedidos:", empresaId);

  db
    .collection("empresas")
    .doc(empresaId)
    .collection("pedidos")
    .onSnapshot(async snapshot => {

      for (const change of snapshot.docChanges()) {

        if (change.type !== "modified") continue;

        try {
          const pedido = change.doc.data();

          const pedidoId = change.doc.id;

          const status = pedido.status;

          const config = await buscarConfigBot(empresaId);

          if (config.ativo === false) continue;

          if (config.avisarKanban === false) continue;

          const numero =
            pedido.whatsapp ||
            pedido.contato ||
            pedido.whatsapp_normalizado;

          if (!numero) continue;

          const notificacoes = pedido.bot_notificacoes || {};

          let mensagem = null;
          let campoControle = null;

          if (
            status === "aceitos" &&
            !notificacoes.aceito
          ) {
            mensagem =
              config.mensagemPedidoAceito ||
              "✅ Seu pedido foi aceito!";

            campoControle = "aceito";
          }

          else if (
            status === "entrega" &&
            !notificacoes.entrega
          ) {
            mensagem =
              config.mensagemSaiuEntrega ||
              "🚗 Seu pedido saiu para entrega!";

            campoControle = "entrega";
          }

          else if (
            status === "finalizado" &&
            !notificacoes.finalizado
          ) {
            mensagem =
              config.mensagemPedidoFinalizado ||
              "✅ Pedido finalizado!";

            campoControle = "finalizado";
          }

          else if (
            status === "cancelado" &&
            !notificacoes.cancelado
          ) {
            mensagem =
              config.mensagemPedidoCancelado ||
              "❌ Pedido cancelado.";

            campoControle = "cancelado";
          }

          if (!mensagem) continue;

          const nomeCliente =
            pedido.nomeCliente ||
            pedido.cliente ||
            "Cliente";

          const textoFinal =
`${mensagem}

👤 ${nomeCliente}
💰 Total: R$ ${pedido.total || 0}`;

          const enviado = await enviarMensagemEmpresa(
            empresaId,
            numero,
            textoFinal
          );

          if (!enviado) continue;

          await change.doc.ref.set({
            bot_notificacoes: {
              ...notificacoes,
              [campoControle]: true,
              atualizado_em:
                admin.firestore.FieldValue.serverTimestamp()
            }
          }, { merge: true });

          console.log(
            "Notificação enviada:",
            empresaId,
            pedidoId,
            status
          );

        } catch (erro) {
          console.log(
            "Erro monitor pedido:",
            erro.message
          );
        }
      }
    });
}

async function iniciarTodosBots() {
  try {
    const snapshot =
      await db.collection("empresas").get();

    for (const doc of snapshot.docs) {

      const empresaId = doc.id;

      try {

        iniciarBotEmpresa(empresaId);

        monitorarPedidosEmpresa(empresaId);

      } catch (erro) {
        console.log(
          "Erro iniciar empresa:",
          empresaId,
          erro.message
        );
      }
    }

  } catch (erro) {
    console.log(
      "Erro iniciarTodosBots:",
      erro.message
    );
  }
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    mensagem:
      "Bot WhatsApp Multiempresa ONLINE"
  });
});

app.post("/bot/iniciar", (req, res) => {
  try {
    const { empresaId } = req.body;

    const resultado =
      iniciarBotEmpresa(empresaId);

    monitorarPedidosEmpresa(empresaId);

    res.json(resultado);

  } catch (erro) {
    res.status(400).json({
      erro: erro.message
    });
  }
});

app.get("/bot/status/:empresaId", (req, res) => {
  const { empresaId } = req.params;

  res.json({
    empresaId,
    status:
      statusBots[empresaId] ||
      "nao_iniciado",

    conectado:
      statusBots[empresaId] === "conectado",

    temQr: !!qrs[empresaId]
  });
});

app.get("/bot/qr/:empresaId", (req, res) => {
  const { empresaId } = req.params;

  res.json({
    empresaId,
    qr: qrs[empresaId] || null,
    status:
      statusBots[empresaId] ||
      "sem_qr"
  });
});

app.post("/bot/enviar", async (req, res) => {
  try {
    const {
      empresaId,
      numero,
      mensagem
    } = req.body;

    if (!empresaId || !numero || !mensagem) {
      return res.status(400).json({
        erro:
          "empresaId, numero e mensagem obrigatórios"
      });
    }

    const enviado =
      await enviarMensagemEmpresa(
        empresaId,
        numero,
        mensagem
      );

    res.json({
      enviado
    });

  } catch (erro) {
    res.status(500).json({
      erro: erro.message
    });
  }
});

app.post("/bot/desconectar", async (req, res) => {
  try {
    const { empresaId } = req.body;

    if (!bots[empresaId]) {
      return res.json({
        empresaId,
        status: "nao_conectado"
      });
    }

    await bots[empresaId].destroy();

    delete bots[empresaId];
    delete qrs[empresaId];

    statusBots[empresaId] = "desconectado";

    res.json({
      empresaId,
      status: "desconectado"
    });

  } catch (erro) {
    res.status(500).json({
      erro: erro.message
    });
  }
});

app.listen(PORT, async () => {
  console.log(
    `Servidor rodando porta ${PORT}`
  );

  await iniciarTodosBots();
});
