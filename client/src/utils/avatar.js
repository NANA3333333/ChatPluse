export const resolveAvatarUrl = (url, apiUrl) => {
    if (!url) return '';
    if (url.startsWith('/uploads/')) {
        return apiUrl.replace(/\/api$/, '') + url;
    }
    return url;
};
