require('dotenv').config();
const sql = require('mssql');
const axios = require('axios');
const express = require('express'); // Adicionado para manter a nuvem ativa

// --- CONFIGURAÇÃO DO SERVIDOR WEB (TRUQUE PARA O RENDER/HEROKU) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('O Robô do WhatsApp está rodando e operante! 🤖');
});

app.listen(PORT, () => {
    console.log(`Servidor Web ouvindo na porta ${PORT}`);
});

// --- CONFIGURAÇÃO DO BANCO DE DADOS (AGORA PODE USAR HOST REMOTO) ---
const dbConfig = {
    user: process.env.DB_USER,        // Defina no .env ou Painel da Nuvem
    password: process.env.DB_PASSWORD,// Defina no .env ou Painel da Nuvem
    server: process.env.DB_SERVER,    // IP ou DNS do seu Banco (Ex: 200.189.x.x)
    database: process.env.DB_NAME || 'biodata',
    options: {
        encrypt: false, 
        trustServerCertificate: true,
        enableArithAbort: true
    }
};

// --- CONFIGURAÇÕES PARTNERBOT ---
const PARTNERBOT_URL = 'https://painel.partnerbot.com.br/v2/api/external/de10bffc-f911-4d63-ac53-80b6648aa5d4/template';
const AUTH_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnRJZCI6OSwicHJvZmlsZSI6ImFkbWluIiwic2Vzc2lvbklkIjo4OSwiaWF0IjoxNzY0MzY2NzI1LCJleHAiOjE4Mjc0Mzg3MjV9.GC18WTtV-nqwQCV9b0GbJsx1dvW2RuHeTbwuy-CDCow';

// TEMPO DE ESPERA (10 segundos)
const INTERVALO_CHECK = 10000;

async function processarFila() {
    let pool;
    try {
        // console.log(`[${new Date().toLocaleTimeString()}] Verificando fila...`); // Comentei para não lotar o log da nuvem
        pool = await sql.connect(dbConfig);

        const querySelect = `
            SELECT top 20
                '55' + w.strTelefone as strtelefone,
                strTipo,
                CASE WHEN a.strAgenda='' THEN W.strAgenda ELSE a.strAgenda END strAgenda,
                intWhatsAppEnvioId, 
                W.intAgendaId,
                convert(varchar,datAgendamento,103) as datagenda,
                strHora,
                a.strProfissional,
                isnull(strUnidade,'Av. Júlia Rodrigues Torres 855 - Floresta, Belo Jardim - PE, CEP:55150-000') as strunidade,
                dbo.fncBase64_Encode(CONVERT(VARCHAR, w.intagendaid) + '-' + CONVERT(VARCHAR, GETDATE(), 120)) AS Link
            from tblWhatsAppEnvio W
            inner join vwAgenda a on a.intAgendaId=w.intAgendaId
            where IsNull(bolEnviado,'N') <> 'S' 
            and strTipo in('agenda','agendainicio','Cadencia')
            and len(W.strTelefone)>=10 
            AND CONVERT(DATE, datWhatsAppEnvio) = CONVERT(DATE, GETDATE())
            order by datWhatsAppEnvio
        `;

        const result = await pool.request().query(querySelect);
        const listaEnvio = result.recordset;

        if (listaEnvio.length > 0) {
            console.log(`🔍 Encontradas ${listaEnvio.length} mensagens para enviar.`);
            
            for (const msg of listaEnvio) {
                try {
                    const p_agenda = (msg.strAgenda || "").replace(/[\r\n"]/g, " ");
                    const p_data = (msg.datagenda || "").replace(/[\r\n"]/g, " ");
                    const p_hora = (msg.strHora || "").replace(/[\r\n"]/g, " ");
                    const p_profissional = (msg.strProfissional || "").replace(/[\r\n"]/g, " ");
                    const p_unidade = (msg.strunidade || "").replace(/[\r\n"]/g, " ");
                    const p_link = (msg.Link || "");

                    let templateName = "";
                    let components = [];

                    if (msg.strTipo.toUpperCase() === 'AGENDAINICIO') {
                        // CASO 1: SEM LINK (Apenas texto)
                        templateName = "primeira_consulta_exame";
                        components = [{
                            type: "body",
                            parameters: [
                                { type: "text", text: p_agenda },
                                { type: "text", text: p_data },
                                { type: "text", text: p_hora },
                                { type: "text", text: p_profissional },
                                { type: "text", text: p_unidade }
                            ]
                        }];
                    } else {
                        // CASO 2: COM LINK (Texto + Botão URL)
                        // Ajustado para 'confirma_nova' conforme seu curl, mas COM O BOTÃO.
                        templateName = "confirma_nova"; 
                        components = [
                            {
                                type: "body",
                                parameters: [
                                    { type: "text", text: p_agenda },
                                    { type: "text", text: p_data },
                                    { type: "text", text: p_hora },
                                    { type: "text", text: p_profissional },
                                    { type: "text", text: p_unidade }
                                ]
                            },
                            {
                                type: "button",
                                sub_type: "url",
                                index: "0",
                                parameters: [
                                    { type: "text", text: p_link }
                                ]
                            }
                        ];
                    }

                    const payload = {
                        number: msg.strtelefone,
                        isClosed: false, 
                        templateData: {
                            messaging_product: "whatsapp",
                            to: msg.strtelefone,
                            type: "template",
                            template: { name: templateName, language: { code: "pt_BR" }, components: components }
                        }
                    };

                    console.log(`📤 Enviando ID ${msg.intWhatsAppEnvioId} (${msg.strTipo})...`);
                    
                    await axios.post(PARTNERBOT_URL, payload, {
                        headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_TOKEN }
                    });

                    await pool.request()
                        .input('id', sql.Int, msg.intWhatsAppEnvioId)
                        .query(`UPDATE tblWhatsAppEnvio SET bolEnviado = 'S', datEnvioReal = GETDATE() WHERE intWhatsAppEnvioId = @id`);
                    
                    console.log(`✅ Sucesso ID: ${msg.intWhatsAppEnvioId}`);

                } catch (errEnvio) {
                    const errorData = errEnvio.response ? JSON.stringify(errEnvio.response.data) : errEnvio.message;
                    console.error(`❌ Erro ID ${msg.intWhatsAppEnvioId}:`, errorData);
                }
            }
        }
    } catch (err) {
        console.error("⚠️ Erro de Conexão ou SQL:", err.message);
    } finally {
        if (pool) pool.close();
    }
}

// Inicia o loop infinito
setInterval(processarFila, INTERVALO_CHECK);
console.log("🚀 Sistema iniciado com servidor Web para nuvem.");