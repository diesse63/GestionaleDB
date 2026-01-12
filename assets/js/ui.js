function injectNavbar() {
    const navbar = `
    <div class="navbar bg-white shadow-md px-4 md:px-8 mb-6 border-b border-gray-100">
        <div class="flex-1">
            <a href="index.html" class="btn btn-ghost text-xl gap-2 font-black tracking-tight">
                <i data-lucide="layout-grid" class="text-primary"></i>
                ${CONFIG.APP_NAME}
            </a>
        </div>
        <div class="flex-none gap-2">
            <div class="badge badge-primary font-bold px-4 py-3">${CONFIG.VERSION}</div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('afterbegin', navbar);
    if (window.lucide) {
        lucide.createIcons();
    }
}