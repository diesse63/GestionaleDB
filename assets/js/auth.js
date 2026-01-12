// Verifica se l'utente è loggato. Se no, lo manda al login.
(function checkAuth() {
    const userRole = sessionStorage.getItem('userRole');
    const path = window.location.pathname;
    const page = path.split("/").pop();

    // Se non è loggato e non è già nella pagina login, reindirizza
    if (!userRole && page !== "login.html" && page !== "") {
        window.location.href = "login.html";
    }
})();

function logout() {
    sessionStorage.clear();
    window.location.href = "login.html";
}