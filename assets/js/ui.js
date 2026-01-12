// PROTEZIONE DELLE PAGINE: Eseguito all'avvio di ogni pagina
(function checkAuth() {
    const userRole = sessionStorage.getItem('userRole');
    const path = window.location.pathname;
    const page = path.split("/").pop();

    // Se l'utente non è loggato e non si trova già nella pagina di login, lo reindirizza
    if (!userRole && page !== "login.html" && page !== "") {
        console.warn("Accesso negato: Utente non autenticato.");
        window.location.href = "login.html";
    }
})();

function injectNavbar() {
    const role = sessionStorage.getItem('userRole') || 'OSPITE';
    const name = sessionStorage.getItem('userName') || 'Utente';
    
    const navbar = `
    <div class="navbar bg-white shadow-md px-4 md:px-8 mb-6 border-b border-gray-100">
        <div class="flex-1">
            <a href="index.html" class="btn btn-ghost text-xl font-black italic tracking-tighter text-primary uppercase">
                Gestione Pro
            </a>
        </div>
        <div class="flex-none gap-4">
            <div class="text-right hidden sm:block">
                <div class="text-[9px] font-black uppercase text-gray-400 tracking-widest leading-none">Accesso Effettuato</div>
                <div class="text-xs font-bold text-gray-700">${name} <span class="text-primary">(${role})</span></div>
            </div>
            <button onclick="logout()" class="btn btn-outline btn-error btn-xs rounded-full px-4">Esci</button>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('afterbegin', navbar);
    if (window.lucide) lucide.createIcons();
}

function logout() {
    sessionStorage.clear();
    window.location.href = "login.html";
}