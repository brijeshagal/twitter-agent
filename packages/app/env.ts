const servers = {
    ["prod"]: process.env.BACKEND_SERVER,
    ["local"]: process.env.BACKEND_SERVER_LOCAL,
};


export const APP_ENV = process.env.APP_ENV || "local";
export const BACKEND_SERVER = servers[APP_ENV];
