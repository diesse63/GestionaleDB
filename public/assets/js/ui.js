document.addEventListener('DOMContentLoaded', () => {
    const isLoginPage = window.location.pathname.includes('login.html');
    
    // Recupera l'utente dalla sessione
    const user = sessionStorage.getItem('userName');

    // Se non sei loggato e non sei sulla pagina di login, vai al login
    if (!user && !isLoginPage) {
        window.location.href = 'login.html';
        return;
    }

    injectNavbar();
    if (typeof lucide !== 'undefined') lucide.createIcons();
});

async function apiFetch(endpoint, options = {}) {
    options.credentials = 'include';
    if (options.body && !options.headers) options.headers = { 'Content-Type': 'application/json' };

    try {
        // --- FIX REFRESH: AGGIUNTA TIMESTAMP PER EVITARE CACHE BROWSER ---
        const separator = endpoint.includes('?') ? '&' : '?';
        const urlWithCacheBuster = `${CONFIG.SCRIPT_URL}${endpoint}${separator}_t=${Date.now()}`;
        
        const response = await fetch(urlWithCacheBuster, options);
        
        if (response.status === 401) {
            sessionStorage.clear();
            window.location.href = 'login.html';
            return null;
        }
        return response.ok ? await response.json() : null;
    } catch (error) {
        console.error("Errore di connessione API:", error);
        return null;
    }
}

function injectNavbar() {
    const header = document.getElementById('main-header');
    if (!header || window.location.pathname.includes('login.html')) return;

    // Recupera il nome utente dalla sessione
    const userName = sessionStorage.getItem('userName') || 'Utente';

    header.innerHTML = `
        <div class="navbar bg-white shadow-xl rounded-2xl mb-6 border border-gray-100">
            <div class="flex-1 px-4"><a href="/" class="btn btn-ghost text-xl font-black italic">GESTIONALE PRO</a></div>
            <div class="flex-none gap-4 px-4">
                <span class="text-sm font-black uppercase italic">${userName}</span>
                <button onclick="handleLogout()" class="btn btn-error btn-outline btn-sm rounded-xl uppercase text-[10px]">Esci</button>
            </div>
        </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function handleLogout() {
    if (!confirm("Uscire?")) return;
    
    try {
        await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {
        console.error("Errore logout server:", e);
    }

    sessionStorage.clear();
    window.location.replace('login.html');
}