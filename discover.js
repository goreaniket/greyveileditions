const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = String(text); if (className) el.className = className; return el; };
const option = (value, text) => { const el = node('option', text); el.value = value; return el; };
const VOLUMES = { I:'Inner World', II:'Limits of Understanding', III:'Stories We Become', IV:'Life We Actually Live' };
function bookCard(book) { const card = node('article', null,'book'); card.append(node('p',`Book ${String(book.journey_number).padStart(2,'0')} · ${book.series}`,'kicker'),node('h3',book.title),node('p',book.core_question));return card; }
function showBooks(data, series='') { const items = data.books.filter(b=>!series||b.series===series);$('books').replaceChildren(...items.map(bookCard));$('book-count').textContent=`${items.length} of ${data.books.length} books in this editorial guide`; }
function resultBook(root, book, label) {if(!book) return;root.append(node('p',label,'kicker'),node('h3',book.title),node('p',book.core_question));}
async function initialize() {const response=await fetch(new URL('./catalogue.json', import.meta.url));if(!response.ok) throw new Error('Catalogue unavailable');const data=await response.json();
const booksByNumber=new Map(data.books.map(b=>[Number(b.journey_number),b]));
const series=[...new Set(data.books.map(b=>b.series))];series.forEach(s=>$('series').append(option(s,s)));$('series').addEventListener('change',()=>showBooks(data,$('series').value));showBooks(data);
data.matches.forEach((m,i)=>$('concern').append(option(String(i),m.reader_concern)));
$('concern').addEventListener('change',()=>{const root=$('match-result');root.replaceChildren();if($('concern').value==='')return;const m=data.matches[Number($('concern').value)];resultBook(root,booksByNumber.get(Number(m.primary_journey_number)),'Suggested starting point');const alt=booksByNumber.get(Number(m.alternative_journey_number));if(alt)root.append(node('p',`Also explore: ${alt.title}`));if(m.primary_anchor)root.append(node('p',`Relevant section: ${m.primary_anchor}`));if(m.why_fit)root.append(node('p',m.why_fit));});
const stages=$('stages');for(const volume of ['I','II','III','IV']){const items=data.books.filter(b=>b.volume===volume).sort((a,b)=>a.journey_number-b.journey_number);const stage=node('section',null,'stage');stage.append(node('p',`Volume ${volume}`,'eyebrow'),node('h3',VOLUMES[volume]));const list=node('ol');for(const b of items){const li=node('li');li.append(node('strong',b.title),document.createTextNode(` — ${b.series}`));list.append(li);}stage.append(list);stages.append(stage);}
data.topics.forEach((t,i)=>$('topic').append(option(String(i),t.topic)));$('topic').addEventListener('change',()=>{const root=$('topic-result');root.replaceChildren();if($('topic').value==='')return;const t=data.topics[Number($('topic').value)];root.append(node('h3',t.topic),node('p',`Suggested reading: ${t.primary_recommendation}`));if(t.other_books)root.append(node('p',`Related: ${t.other_books}`));});
}
initialize().catch(()=>{$('books').replaceChildren(node('p','The guide could not load. Please try again later.'));});
