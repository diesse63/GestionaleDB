/**
 * API MANAGER - Gestionale Pro
 * Gestisce la comunicazione tra il Frontend e Google Apps Script
 */

// 1. Funzione per LEGGERE i dati (Utilizzata per caricare tabelle e menu)
async function getAnagraficaData(sheetName = "Associazioni") {
    try {
        // Aggiungiamo un timestamp (t=...) per evitare che il browser carichi dati vecchi dalla cache
        const url = `${CONFIG.SCRIPT_URL}?sheet=${sheetName}&t=${new Date().getTime()}`;
        
        console.log(`%c[API GET] %cRichiesta dati per il foglio: ${sheetName}`, "color: blue; font-weight: bold", "color: gray");

        const response = await fetch(url, {
            method: 'GET',
            mode: 'cors',
            redirect: 'follow'
        });

        if (!response.ok) throw new Error(`Errore HTTP: ${response.status}`);

        const data = await response.json();
        
        // Se lo script restituisce un errore interno di Google
        if (data.error) {
            console.error("[API ERROR]", data.error);
            return [];
        }

        return data;
    } catch (error) {
        console.error("%c[API ERROR] %cImpossibile recuperare i dati:", "color: red; font-weight: bold", "color: gray");
        console.error(error);
        return [];
    }
}

// 2. Funzione per INVIARE dati (Utilizzata per Login, Update e Delete)
async function sendDataAction(payload) {
    try {
        console.log(`%c[API POST] %cAzione richiesta: ${payload.action}`, "color: orange; font-weight: bold", "color: gray");

        const response = await fetch(CONFIG.SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors', // Importante per bypassare alcuni blocchi CORS su POST semplici
            redirect: 'follow',
            headers: {
                'Content-Type': 'text/plain;charset=utf-8', 
                // Usiamo text/plain per evitare pre-flight OPTIONS che Google Script non gestisce bene
            },
            body: JSON.stringify(payload)
        });

        /**
         * NOTA TECNICA: Google Apps Script con mode: 'no-cors' non restituisce il corpo della risposta.
         * Per il LOGIN e le operazioni che richiedono conferma, dobbiamo usare un approccio diverso.
         */
        
        // Se l'azione è il LOGIN, usiamo una fetch standard con permessi pieni
        if (payload.action === "login" || payload.action === "update" || payload.action === "delete") {
            const secureResponse = await fetch(CONFIG.SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return await secureResponse.json();
        }

        return { result: "success" };

    } catch (error) {
        console.error("%c[API ERROR] %cErrore nell'invio dei dati:", "color: red; font-weight: bold", "color: gray");
        console.error(error);
        return { result: "error", message: error.message };
    }
}