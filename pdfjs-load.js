// CETG claim form - brings in the PDF renderer (pdf.js, an ES module) for the page's scripts.
// pdfread.js adds this file as a module script when a PDF receipt is first added.
import * as pdfjs from './pdfjs.min.js';
window.pdfjsLib = pdfjs;
