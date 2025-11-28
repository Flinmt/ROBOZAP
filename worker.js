require('dotenv').config();
const sql = require('mssql');
const axios = require('axios');
const express = require('express');

// --- CONFIGURAÇÃO DO SERVIDOR WEB ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('O Robô do WhatsApp está rodando e operante! 🤖 (Template: confirma_nova)');
});

app.listen(PORT, () => {
    console.log(`Servidor Web ouvindo na porta ${PORT}`);
});

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
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

const INTERVALO_CHECK = 10000;

// Função auxiliar para limpar texto e evitar erro 400 (vazio)
function limparTexto(texto) {
    if (texto === null || texto === undefined) return "-"; 
    // Remove quebras de linha e aspas que podem quebrar o JSON
    const textoLimpo = String(texto).replace(/[\r\n"]/g, " ").trim();
    // Meta rejeita strings vazias, então enviamos um traço ou espaço
    return textoLimpo === "" ? "-" : textoLimpo;
}

async function processarFila() {
    let pool;
    try {
        pool = await sql.connect(dbConfig);

        // Filtro ajustado APENAS para 'agendainicio'
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
            and strTipo = 'agendainicio' 
            and len(W.strTelefone)>=10 
            AND CONVERT(DATE, datWhatsAppEnvio) = CONVERT(DATE, GETDATE())
            order by datWhatsAppEnvio
        `;

        const result = await pool.request().query(querySelect);
        const listaEnvio = result.recordset;

        if (listaEnvio.length > 0) {
            console.log(`🔍 Encontradas ${listaEnvio.length} mensagens do tipo AGENDAINICIO.`);
            
            for (const msg of listaEnvio) {
                try {
                    // Limpeza de variáveis
                    const p_agenda = limparTexto(msg.strAgenda);
                    const p_data = limparTexto(msg.datagenda);
                    const p_hora = limparTexto(msg.strHora);
                    const p_profissional = limparTexto(msg.strProfissional);
                    const p_unidade = limparTexto(msg.strunidade);
                    
                    // Limpeza do telefone (garante apenas números)
                    const telefoneFinal = String(msg.strtelefone).replace(/\D/g, "");

                    // --- AJUSTE CRÍTICO: Usando o template que funcionou no seu CURL ---
                    const templateName = "confirma_nova";
                    
                    const parameters = [
                        { type: "text", text: p_agenda },       // {{1}}
                        { type: "text", text: p_data },         // {{2}}
                        { type: "text", text: p_hora },         // {{3}}
                        { type: "text", text: p_profissional }, // {{4}}
                        { type: "text", text: p_unidade }       // {{5}}
                    ];

                    const components = [{
                        type: "body",
                        parameters: parameters
                    }];

                    const payload = {
                        number: telefoneFinal,
                        isClosed: false, 
                        templateData: {
                            messaging_product: "whatsapp",
                            to: telefoneFinal,
                            type: "template",
                            template: { name: templateName, language: { code: "pt_BR" }, components: components }
                        }
                    };

                    console.log(`📤 Enviando ID ${msg.intWhatsAppEnvioId} para ${telefoneFinal}...`);
                    console.log(`   Template: ${templateName}`);
                    
                    await axios.post(PARTNERBOT_URL, payload, {
                        headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_TOKEN }
                    });

                    // Sucesso: Atualiza banco
                    await pool.request()
                        .input('id', sql.Int, msg.intWhatsAppEnvioId)
                        .query(`UPDATE tblWhatsAppEnvio SET bolEnviado = 'S', datEnvioReal = GETDATE() WHERE intWhatsAppEnvioId = @id`);
                    
                    console.log(`✅ Sucesso ID: ${msg.intWhatsAppEnvioId}`);

                } catch (errEnvio) {
                    let errorMsg = errEnvio.message;
                    // Tenta ler o erro detalhado que vem da Meta/PartnerBot
                    if (errEnvio.response && errEnvio.response.data) {
                        try {
                            const dataStr = JSON.stringify(errEnvio.response.data);
                            errorMsg = dataStr; 
                        } catch (e) {
                            errorMsg = "Erro desconhecido na resposta da API";
                        }
                    }
                    console.error(`❌ Erro ID ${msg.intWhatsAppEnvioId}:`, errorMsg);
                }
            }
        }
    } catch (err) {
        console.error("⚠️ Erro de Conexão ou SQL:", err.message);
    } finally {
        if (pool) pool.close();
    }
}

setInterval(processarFila, INTERVALO_CHECK);
console.log("🚀 Sistema iniciado (Template Corrigido: confirma_nova).");