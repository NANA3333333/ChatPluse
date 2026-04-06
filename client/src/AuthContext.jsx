import React, { createContext, useState, useContext } from 'react';

export const AuthContext = createContext();

function readStoredUser() {
    const saved = localStorage.getItem('cp_user');
    if (!saved) return null;
    try {
        return JSON.parse(saved);
    } catch (error) {
        console.warn('[AuthContext] Failed to parse cp_user from localStorage. Clearing corrupted state.', error);
        localStorage.removeItem('cp_user');
        return null;
    }
}

export function useAuth() {
    return useContext(AuthContext);
}

export function AuthProvider({ children }) {
    const [token, setToken] = useState(localStorage.getItem('cp_token'));
    const [user, setUser] = useState(() => readStoredUser());

    const login = (newToken, newUser) => {
        setToken(newToken);
        setUser(newUser);
        localStorage.setItem('cp_token', newToken);
        localStorage.setItem('cp_user', JSON.stringify(newUser));
    };

    const updateUser = (nextUser) => {
        setUser(nextUser);
        localStorage.setItem('cp_user', JSON.stringify(nextUser));
    };

    const logout = () => {
        setToken(null);
        setUser(null);
        localStorage.removeItem('cp_token');
        localStorage.removeItem('cp_user');
        window.location.reload();
    };

    return (
        <AuthContext.Provider value={{ token, user, login, logout, updateUser }}>
            {children}
        </AuthContext.Provider>
    );
}
