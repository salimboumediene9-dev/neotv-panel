const products = [
  {id:"iptv-premium",name:"IPTV Premium",type:"iptv",description:"خطة تجريبية لمحتوى تملكه أو تملك حق توزيعه.",price:7,period:"شهرياً",symbol:"▣",tag:"متاح"},
  {id:"iptv-arabic",name:"IPTV Arabic",type:"iptv",description:"باقة قنوات عربية مرخصة حسب حقوق التوزيع.",price:5,period:"شهرياً",symbol:"◉",tag:"متاح"},
  {id:"iptv-sports",name:"IPTV Sports",type:"iptv",description:"خطة رياضية توضيحية للمحتوى المرخّص فقط.",price:6,period:"شهرياً",symbol:"⚽",tag:"متاح"},
  {id:"vps-1",name:"VPS Starter",type:"server",description:"1 vCPU • RAM 2GB • SSD 20GB",price:5,period:"شهرياً",symbol:"▤",tag:"متاح"},
  {id:"vps-2",name:"VPS Pro",type:"server",description:"2 vCPU • RAM 4GB • SSD 40GB",price:9,period:"شهرياً",symbol:"▤",tag:"متاح"},
  {id:"vps-4",name:"VPS Business",type:"server",description:"4 vCPU • RAM 8GB • SSD 80GB",price:15,period:"شهرياً",symbol:"▤",tag:"متاح"}
];
let orders = [
  {id:"NT-1042",productId:"iptv-premium",customer:"عميل تجريبي",status:"مكتمل"},
  {id:"NT-1041",productId:"vps-2",customer:"عميل تجريبي",status:"مكتمل"},
  {id:"NT-1040",productId:"iptv-sports",customer:"عميل تجريبي",status:"قيد المعالجة"}
];
const $ = id => document.getElementById(id);
function money(value){return (value).toLocaleString("en-US",{style:"currency",currency:$("currency")?.value||"USD",maximumFractionDigits:2});}
function card(p){
  return `<article class="product-card" data-name="${p.name.toLowerCase()} ${p.description.toLowerCase()}">
    <div class="product-art ${p.type==="iptv"?"iptv-art":""}"><div class="art-lines"></div><span class="big-symbol">${p.symbol}</span><span class="product-tag">${p.tag}</span></div>
    <h3>${p.name}</h3><p class="desc">${p.description}</p>
    <div class="product-bottom"><span class="price">${money(p.price)}<small>${p.period}</small></span><span class="muted" style="font-size:10px">${p.type==="server"?"سيرفر خاص":"اشتراك"}</span></div>
    <button class="primary-btn" data-order="${p.id}">اطلب الآن ←</button>
  </article>`;
}
function renderProducts(){
  $("productGrid").innerHTML=products.slice(0,3).map(card).join("");
  $("allProductGrid").innerHTML=products.map(card).join("");
  $("serverGrid").innerHTML=products.filter(p=>p.type==="server").map(card).join("");
  $("iptvGrid").innerHTML=products.filter(p=>p.type==="iptv").map(card).join("");
}
function renderOrders(){
  $("ordersBody").innerHTML=orders.slice().reverse().map(o=>{
    const p=products.find(x=>x.id===o.productId);
    return `<tr><td>${o.id}</td><td>${p?.name||"منتج"}</td><td>${o.customer}</td><td><span class="status-pill">${o.status}</span></td><td>${p?money(p.price):"—"}</td></tr>`;
  }).join("");
  $("orderBadge").textContent=orders.filter(o=>o.status!=="مكتمل").length;
  $("totalOrders").textContent=256+Math.max(0,orders.length-3);
}
function showToast(message){$("toast").textContent=message;$("toast").classList.add("show");setTimeout(()=>$("toast").classList.remove("show"),3800);}
function switchView(view){
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===view));
  document.querySelectorAll("[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  if(!$(view)) return;
  window.scrollTo({top:0,behavior:"smooth"});
}
document.addEventListener("click",e=>{
  const nav=e.target.closest("[data-view]");
  if(nav){switchView(nav.dataset.view);return;}
  const orderBtn=e.target.closest("[data-order]");
  if(orderBtn){
    const p=products.find(x=>x.id===orderBtn.dataset.order); if(!p)return;
    $("productId").value=p.id;$("modalTitle").textContent="طلب "+p.name;
    $("modalDescription").textContent=`السعر التجريبي: ${money(p.price)} ${p.period}. لا يوجد دفع حقيقي.`;
    $("orderModal").classList.add("open");$("orderModal").setAttribute("aria-hidden","false");return;
  }
});
$("closeModal").addEventListener("click",closeModal);
$("orderModal").addEventListener("click",e=>{if(e.target===$("orderModal"))closeModal();});
function closeModal(){$("orderModal").classList.remove("open");$("orderModal").setAttribute("aria-hidden","true");}
$("orderForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const p=products.find(x=>x.id===$("productId").value);
  const customerName=$("customerName").value.trim(),contact=$("contact").value.trim();
  if(!p||!customerName||!contact)return;
  try{
    const r=await fetch("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({productId:p.id,customerName,contact})});
    const data=await r.json();
    if(!r.ok)throw new Error(data.message||"تعذر تسجيل الطلب");
    orders.push({id:data.order.id,productId:p.id,customer:customerName,status:"قيد المعالجة"});
    renderOrders();closeModal();$("orderForm").reset();showToast(data.message);switchView("orders");
  }catch(err){showToast(err.message||"تعذر الاتصال بالخادم.");}
});
$("searchInput").addEventListener("input",e=>{
  const q=e.target.value.trim().toLowerCase();
  document.querySelectorAll(".product-card").forEach(c=>c.style.display=c.dataset.name.includes(q)?"":"none");
});
$("saveSettings").addEventListener("click",()=>{showToast("تم حفظ إعدادات العرض لهذه الجلسة فقط.");$("settingsMsg").textContent="تم الحفظ محلياً للمعاينة فقط؛ لا تُحفظ الإعدادات على الخادم.";});
$("addProductBtn").addEventListener("click",()=>showToast("في النسخة التجريبية، تعديل المنتجات يتم داخل public/app.js. نحتاج قاعدة بيانات ولوحة إدارة آمنة للإضافة الحقيقية."));
renderProducts();renderOrders();