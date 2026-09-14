import { defineConfig } from 'vite';
export default defineConfig({server:{host:'::',port:9150,strictPort:true},build:{target:'es2022'},worker:{format:'es'}});
