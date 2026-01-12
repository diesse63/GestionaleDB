// Aggiungiamo il parametro sheetName alla funzione
async function getAnagraficaData(sheetName = "Associazioni") {
    try {
        // Costruiamo l'URL con il nome del foglio e un timestamp per evitare la cache
        const url = `${CONFIG.SCRIPT_URL}?sheet=${sheetName}&t=${new Date().getTime()}`;
        
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow'
        });
        
        if (!response.ok) throw new Error("Errore di rete");
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error("Errore Fetch:", error);
        return [];
    }
async function sendDataAction(payload) {
    try {
        const response = await fetch(CONFIG.SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        return await response.json();
    } catch (error) {
        console.error("Errore salvataggio:", error);
        return {result: "error"};
    }
}}