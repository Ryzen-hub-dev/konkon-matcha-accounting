export type ManualLanguage = "zh" | "en";

type ManualCopy = {
  title: string;
  summary: string;
  steps: string[];
  tips: string[];
};

export type ManualTopic = {
  id: string;
  group: "START" | "SALES" | "STOCK" | "FINANCE" | "ADMIN";
  roles: string[];
  zh: ManualCopy;
  en: ManualCopy;
};

export const MANUAL_GROUPS = {
  zh: {
    START: "开始使用",
    SALES: "销售与客户",
    STOCK: "库存与采购",
    FINANCE: "会计与财务控制",
    ADMIN: "管理、安全与支持",
  },
  en: {
    START: "Getting started",
    SALES: "Sales and customers",
    STOCK: "Inventory and purchasing",
    FINANCE: "Accounting and financial control",
    ADMIN: "Administration, security and support",
  },
} as const;

export const USER_MANUAL_TOPICS: ManualTopic[] = [
  {
    id: "first-login", group: "START", roles: ["All users"],
    zh: { title: "首次登录与界面", summary: "安全登录、修改临时密码，并认识工作区的基本操作。", steps: ["打开系统网址并输入管理员提供的用户名和密码。", "系统要求时立即设置新密码；不要与其他网站共用密码。", "使用左侧菜单进入功能，手机上先点击菜单按钮。", "右上区域显示当前页面，页面底部显示公司、记账币种与时区。", "完成工作后从左下角用户菜单退出登录。"], tips: ["页面提示会说明成功、警告或需要修正的内容。", "看不到某个菜单通常表示当前角色没有权限，请联系 Owner 或 Admin。"] },
    en: { title: "First sign-in and navigation", summary: "Sign in safely, replace a temporary password and learn the workspace layout.", steps: ["Open the workspace URL and enter the username and password issued by an administrator.", "Create a new password immediately when prompted and do not reuse a password from another service.", "Use the left navigation to open a module; on a phone, open the menu first.", "The top bar identifies the current page and the footer shows the company, book currency and time zone.", "Sign out from the user control at the bottom left when work is complete."], tips: ["Page notices explain completed actions, warnings and corrections.", "A missing menu normally means the current role does not have permission; ask an Owner or Admin."] },
  },
  {
    id: "roles", group: "START", roles: ["Owner", "Admin"],
    zh: { title: "角色与权限", summary: "按职责分配最少权限，所有关键检查仍由服务器执行。", steps: ["Owner 拥有公司控制、安全设置和全部业务权限。", "Admin 管理日常工作区与团队，但不能转让所有权。", "Manager 负责门店、销售、库存、采购与业务报告。", "Accountant 负责账簿、发票、应付、报表与月结。", "Cashier 负责销售、会员、收据和只读库存。"], tips: ["采购审批尽量由不同于制单人的授权人员完成；Owner 可在小企业场景中覆盖。", "不要共享账号；审计记录会保存实际操作人。"] },
    en: { title: "Roles and access", summary: "Assign least-privilege access by responsibility; critical checks remain server enforced.", steps: ["Owner has company control, security settings and all operating permissions.", "Admin runs the workspace and team but cannot transfer ownership.", "Manager operates counters, sales, inventory, purchasing and operational reports.", "Accountant maintains books, invoices, payables, reporting and close activities.", "Cashier sells, serves members, handles receipts and reads stock."], tips: ["Where practical, a purchase order should be approved by someone other than its maker; the Owner has a small-business override.", "Never share accounts because audit evidence identifies the actual operator."] },
  },
  {
    id: "owner-setup", group: "START", roles: ["Owner"],
    zh: { title: "Owner 首次设置清单", summary: "按正确顺序准备公司、门店、付款、团队与存储。", steps: ["在 Workspace 设置公司名称、国家、地区格式、时区、税务显示和固定记账币种。", "建立门店/仓库 Location，再建立收银 Counter。", "配置现金、银行、DuitNow 或其他付款方式；外币业务先建立汇率。", "建立团队账号并分配角色。", "如需费用附件，由 Owner 配置私有 GitHub 仓库及具备 Contents 读写权限的细粒度 Token。", "建立产品、期初库存、供应商、客户和会计科目后再开始正式交易。"], tips: ["一旦账簿已有分录，记账币种不能更改。", "先用测试销售和测试采购走完整流程，再开始正式营业。"] },
    en: { title: "Owner first-setup checklist", summary: "Prepare the company, locations, payments, team and storage in the correct order.", steps: ["In Workspace, set the company name, country, regional format, time zone, tax display and permanent book currency.", "Create Locations for shops and warehouses, then create Counters.", "Configure cash, bank, DuitNow or other payment methods; add exchange rates before foreign-currency purchasing.", "Create individual team accounts and assign roles.", "If expense evidence is required, the Owner configures a private GitHub repository and a fine-grained token with Contents read/write access.", "Create products, opening stock, suppliers, customers and ledger accounts before live transactions."], tips: ["The accounting currency cannot be changed after ledger entries exist.", "Run one test sale and one test purchase through the full workflow before going live."] },
  },
  {
    id: "daily-opening", group: "START", roles: ["Cashier", "Manager"],
    zh: { title: "每日开班与交班", summary: "在正确柜台开班、记录开班现金并在日终核对。", steps: ["进入 Counters，确认设备对应的门店与柜台。", "用实际钱箱金额开班，不要填写预计金额。", "在整个班次使用同一个柜台进行销售和退款。", "交班时清点实际现金，填写差异说明并关闭班次。", "Manager 在 Reviews 和报表中检查异常退款、差异和未关闭班次。"], tips: ["未开班时，受控柜台不会允许正常收银。", "现金差异应保留解释，不要用删除交易来掩盖。"] },
    en: { title: "Daily opening and shift handover", summary: "Open the correct counter, record real opening cash and reconcile at day end.", steps: ["Open Counters and confirm the device is assigned to the correct location and counter.", "Open the shift with the physically counted till amount, not an estimate.", "Use the same counter for sales and refunds throughout the shift.", "At handover, count actual cash, explain any difference and close the shift.", "A Manager reviews unusual refunds, variances and unclosed shifts in Reviews and reports."], tips: ["A controlled counter will not allow normal checkout without an open shift.", "Keep an explanation for cash differences; never hide them by deleting transactions."] },
  },
  {
    id: "pos", group: "SALES", roles: ["Cashier", "Manager"],
    zh: { title: "POS 销售", summary: "选择商品、会员、优惠与付款方式并由服务器核算成交。", steps: ["进入 Point of sale，确认柜台和销售地点。", "搜索或扫描商品，调整数量；系统显示服务器计算后的价格、折扣、税和总额。", "需要时搜索会员，或使用 QR/NFC 选择凭证。", "应用有效优惠券并确认资格与折扣。", "选择付款方式并完成结账；不要把付款动画当作银行结算证明。", "打开生成的收据，打印、导出或提供安全的客户收据链接。"], tips: ["网络中断时不要重复点击；先刷新收据列表确认交易是否成功。", "历史价格、成本、税、维度和批次会冻结在交易快照内。"] },
    en: { title: "Point-of-sale sales", summary: "Select products, members, discounts and payment methods while the server calculates the sale.", steps: ["Open Point of sale and confirm the counter and selling location.", "Search or scan products and adjust quantities; the server-calculated price, discount, tax and total are displayed.", "Search for a member or use a QR/NFC selection credential when needed.", "Apply an eligible coupon and verify the discount.", "Choose a payment method and complete checkout; a payment animation is not bank-settlement proof.", "Open the issued receipt to print, export or share its protected customer link."], tips: ["After a connection interruption, do not repeatedly submit; refresh Receipts first to confirm whether the sale completed.", "Historical price, cost, tax, dimensions and batch allocations are frozen in the transaction snapshot."] },
  },
  {
    id: "receipts-refunds", group: "SALES", roles: ["Cashier", "Manager"],
    zh: { title: "收据与退款", summary: "查询不可变收据，并用明确退款留下反向证据。", steps: ["在 Receipts 按编号、会员或日期查找交易。", "打开详情检查商品、付款、税、积分和操作者。", "选择可退款商品及数量，填写真实退款理由。", "确认退款方式后提交；库存、积分、会计和批次按原快照一起冲回。", "多次部分退款时，系统会防止累计数量或金额超过原销售。"], tips: ["已开出的销售不要直接改写；使用退款。", "实际资金退回仍须以支付渠道或银行记录为准。"] },
    en: { title: "Receipts and refunds", summary: "Find immutable receipts and use explicit refunds to preserve reversal evidence.", steps: ["Use Receipts to find a transaction by number, member or date.", "Open the detail to inspect products, payments, tax, points and operator.", "Select refundable products and quantities and enter the real reason.", "Confirm the refund method and post it; stock, points, accounting and batches reverse from the original snapshot together.", "For repeated partial refunds, the system prevents cumulative quantity or value from exceeding the sale."], tips: ["Never rewrite an issued sale; create a refund.", "Actual movement of funds must still be confirmed through the payment provider or bank record."] },
  },
  {
    id: "members", group: "SALES", roles: ["Cashier", "Manager"],
    zh: { title: "会员、QR/NFC 与优惠券", summary: "安全维护会员资料、选择凭证、积分和营销优惠。", steps: ["在 Members 新建会员并只收集业务所需资料。", "发放 QR/NFC 选择凭证时，仅向本人展示一次完整 Token；遗失后撤销并重发。", "在 POS 使用搜索、模糊匹配、QR 或 NFC 选择会员。", "在 Coupons 设置代码、有效期、门槛、次数和会员条件。", "退款会按规则撤销相关积分；停用会员后不得继续使用其凭证。"], tips: ["QR/NFC 只用于选择，不是登录认证。", "不要在备注中保存完整身份证、银行卡或敏感支付资料。"] },
    en: { title: "Members, QR/NFC and coupons", summary: "Maintain member data, selection credentials, points and promotions safely.", steps: ["Create a member in Members and collect only information needed by the business.", "When issuing a QR/NFC selection credential, show the full token to the holder once; revoke and reissue a lost credential.", "At POS, use search, fuzzy matching, QR or NFC to select a member.", "In Coupons, set the code, validity, threshold, usage limits and member conditions.", "Refunds reverse related points under the configured rules; an inactive member credential cannot be used."], tips: ["QR/NFC credentials select records; they do not authenticate a user.", "Do not store complete identity, card or sensitive payment data in notes."] },
  },
  {
    id: "customer-sales", group: "SALES", roles: ["Manager", "Accountant"],
    zh: { title: "报价、送货单、发票与客户信用", summary: "从报价走到发票，同时保留状态、金额与信用决定。", steps: ["在 Customer accounts 建立客户、账期、信用额度和发票默认值。", "建立 Quotation，核对商品、税、有效期后再标记发送或接受。", "只有已接受报价可转换为唯一发票草稿；需要时建立关联 Delivery order。", "发票草稿确认后发送，系统在同一交易中重新检查客户信用额度。", "客户 Statement 排除草稿和作废单；它是内部对账资料，不等同外部收款证明。"], tips: ["报价与送货状态是内部操作证据，不代表客户电子签收。", "超额信用决定会保存快照，不能靠并发发送绕过。"] },
    en: { title: "Quotations, delivery, invoices and customer credit", summary: "Move from quotation to invoice while preserving state, money and credit decisions.", steps: ["Create a customer account with terms, credit limit and invoice defaults.", "Create a Quotation and verify products, tax and validity before marking it sent or accepted.", "Only an accepted quotation can become its single invoice draft; create a linked Delivery order when required.", "Send a reviewed invoice draft; the customer credit limit is rechecked in the same transaction.", "Customer Statements exclude drafts and voids and are internal reconciliation records, not external payment proof."], tips: ["Quotation and delivery states are internal operational evidence, not electronic customer acceptance.", "Credit decisions are snapshotted and concurrent sends cannot bypass the limit."] },
  },
  {
    id: "products-stock", group: "STOCK", roles: ["Manager", "Admin"],
    zh: { title: "商品与基础库存", summary: "建立 SKU、价格、成本、补货点及管理维度默认值。", steps: ["在 Inventory 新建唯一 SKU，填写名称、单位、售价、成本和补货水平。", "按需要启用批次追踪，并设置默认成本中心或项目。", "使用受控期初库存或调整建立实际数量，不要通过直接改商品隐藏差异。", "定期检查低库存、负数风险、最后采购成本和产品状态。", "归档前确保没有仍需销售或采购的业务；历史交易继续保留产品快照。"], tips: ["成本用于会计和毛利，必须由授权人员维护。", "产品维度默认值只影响未来交易。"] },
    en: { title: "Products and core inventory", summary: "Create SKUs, prices, costs, reorder points and management-dimension defaults.", steps: ["Create a unique SKU in Inventory and enter its name, unit, selling price, cost and reorder level.", "Enable batch tracking when required and choose default cost-centre or project classifications.", "Establish real quantities through a controlled opening balance or adjustment; never edit a product to hide a difference.", "Review low stock, negative-stock risk, last purchase cost and product status regularly.", "Before archiving, confirm the item is no longer needed for sales or purchasing; history keeps its product snapshot."], tips: ["Cost drives accounting and margin, so only authorised staff should maintain it.", "Product dimension defaults affect future transactions only."] },
  },
  {
    id: "batch-stocktake", group: "STOCK", roles: ["Manager"],
    zh: { title: "批次、效期、盘点与报废", summary: "追踪供应商批号、FEFO 分配、实际盘点和损耗。", steps: ["收货批次商品时输入供应商批号和晚于收货日的效期。", "在 Batch & expiry 查看即将到期、过期和新鲜度预测。", "销售使用受控批次分配；不要手工绕过批次数量。", "创建 Stocktake，输入实际盘点数，复核差异后再过账。", "对过期、损坏或损耗使用 disposal/write-off，并保存原因和会计证据。"], tips: ["盘点期间避免同时进行大量调拨或收货。", "报废不是删除，它会保留库存和会计冲减记录。"] },
    en: { title: "Batches, expiry, stocktakes and disposal", summary: "Track supplier lots, FEFO allocation, physical counts and inventory loss.", steps: ["When receiving a batch-tracked product, enter the supplier lot and an expiry date after the receipt date.", "Use Batch & expiry to review upcoming expiry, expired stock and freshness forecasts.", "Sales use controlled batch allocation; do not bypass batch quantities manually.", "Create a Stocktake, enter physical counts and review differences before posting.", "Use disposal/write-off for expiry, damage or loss and preserve the reason and accounting evidence."], tips: ["Avoid heavy transfers or receiving while a physical count is in progress.", "A disposal is not deletion; it preserves the stock and accounting reduction."] },
  },
  {
    id: "transfers", group: "STOCK", roles: ["Manager"],
    zh: { title: "跨地点调拨", summary: "用发出和收货两步保留在途库存责任。", steps: ["在 Stock transfers 选择来源、目的地和需要调拨的商品。", "核对来源库存与批次后批准/发出。", "运输期间记录保持在途，不要在目的地提前销售。", "目的地实际收货后确认数量和批次。", "差异或取消必须使用允许的状态操作并填写原因。"], tips: ["来源和目的地不能相同。", "历史调拨不会因为门店改名而丢失原快照。"] },
    en: { title: "Multi-location transfers", summary: "Use dispatch and receipt stages to preserve responsibility for in-transit stock.", steps: ["In Stock transfers, choose the source, destination and products.", "Verify source stock and batches, then approve and dispatch.", "Stock remains in transit during transport; do not sell it at the destination early.", "The destination confirms actual quantities and batches on receipt.", "Handle differences or cancellation through allowed state actions with a reason."], tips: ["Source and destination cannot be the same.", "Historical transfers keep their original snapshots even if a location is renamed."] },
  },
  {
    id: "purchasing", group: "STOCK", roles: ["Manager", "Accountant"],
    zh: { title: "供应商、采购与智能补货", summary: "从补货建议建立承诺，审批后分批收货并自动生成应付。", steps: ["在 Purchasing & payables 建立供应商、币种、账期、交期和最低订单。", "查看 Replenishment queue；建议结合库存、在途量、补货点和近 30 日需求。", "建立采购单草稿，选择供应商、地点、日期、税和商品成本。", "由授权人员审批；非 Owner 通常不能审批自己建立的采购单。", "实际到货时仅输入本次收到数量、供应商发票号、批次和日期。", "最后不会再到货时，对部分收货单使用 Close remainder 并填写原因。"], tips: ["收货会在一个数据库交易中更新库存、加权成本、应付、总账和审计。", "智能补货是建议，订货前仍须确认季节性、促销和供应商能力。"] },
    en: { title: "Suppliers, purchasing and smart replenishment", summary: "Create commitments from replenishment advice, approve them and receive in stages into payables.", steps: ["In Purchasing & payables, create a supplier with currency, terms, lead time and minimum order.", "Review the Replenishment queue; advice combines stock, inbound quantity, reorder level and recent 30-day demand.", "Create a purchase-order draft with supplier, destination, date, tax and product costs.", "Have an authorised user approve it; non-Owners normally cannot approve their own order.", "On physical delivery, enter only the quantity received now, supplier invoice number, batches and dates.", "If no more goods will arrive, use Close remainder on a partially received order and record the reason."], tips: ["Receipt updates inventory, weighted cost, payable, general ledger and audit together in one database transaction.", "Smart replenishment is advice; check seasonality, promotions and supplier capacity before ordering."] },
  },
  {
    id: "payables", group: "STOCK", roles: ["Accountant", "Owner"],
    zh: { title: "应付账款、账龄与付款", summary: "查看到期风险、导出账龄并用真实银行参考号结算。", steps: ["打开 Bills & payments，检查 Current、1–30、31–60、61–90 与超过 90 天账龄。", "查看未来 7 天到期金额、逾期敞口和供应商集中度。", "需要复核或交给外部会计时导出 Aging CSV。", "选择账单，输入本次付款金额、付款账户、真实银行参考号和付款日期。", "外币账单付款会按当前汇率计算并自动记录汇兑损益。"], tips: ["系统付款记录不是银行已结算证明，必须与银行对账。", "不要重复使用银行参考号；重复提交会被拦截。"] },
    en: { title: "Accounts payable, aging and payment", summary: "Review maturity risk, export aging and settle with a real bank reference.", steps: ["Open Bills & payments and review Current, 1–30, 31–60, 61–90 and over-90-day buckets.", "Review amounts due in seven days, overdue exposure and supplier concentration.", "Export the Aging CSV for review or external-accountant working papers.", "Select a bill and enter the payment amount, payment account, real bank reference and payment date.", "Foreign-currency payments use the active rate and automatically post exchange gain or loss."], tips: ["A payment record is not proof that the bank settled it; reconcile it to the bank statement.", "Do not reuse a bank reference; duplicate submissions are blocked."] },
  },
  {
    id: "expenses", group: "FINANCE", roles: ["All users", "Manager", "Accountant"],
    zh: { title: "员工费用与附件凭证", summary: "提交、审核、批准和支付费用，同时保护原始附件。", steps: ["员工建立 Expense claim 草稿，填写日期、科目、金额、税务和业务说明。", "逐个上传最多 10 个附件；系统保留原始字节并只在确实更小时使用无损压缩。", "提交后由合资格审核者审批；非 Owner 不能审核自己的费用。", "Accountant/Owner 使用真实付款账户和参考号付款。", "预览与下载都会检查权限和完整性并分别写入审计。"], tips: ["HEIC/HEIF 可能只能下载，常见图片、PDF 与文本可在系统预览。", "删除草稿附件只会标记移除，受保护的历史副本与审计仍保留。"] },
    en: { title: "Employee expenses and evidence", summary: "Submit, review, approve and pay claims while protecting original evidence.", steps: ["An employee creates an Expense claim draft with date, account, amount, tax and business explanation.", "Upload up to ten files sequentially; exact original bytes are retained and lossless compression is used only when smaller.", "Submit for an eligible reviewer; a non-Owner cannot review their own claim.", "An Accountant or Owner pays with the real payment account and reference.", "Preview and download both enforce access and integrity and create separate audit events."], tips: ["HEIC/HEIF may remain download-only; common images, PDFs and text preview in the app.", "Removing a draft attachment marks it removed; the protected historical copy and audit evidence remain."] },
  },
  {
    id: "journals", group: "FINANCE", roles: ["Accountant"],
    zh: { title: "会计科目与日记账", summary: "建立平衡分录，并使用明确冲销而不是改写已过账证据。", steps: ["在 Accounting 检查会计科目是否与业务用途一致。", "建立日记账日期、说明和借贷行；借方合计必须等于贷方合计。", "需要管理分析时选择有效成本中心或项目。", "过账前复核期间、账户、税务说明和支持文件。", "错误的已过账分录使用冲销和新分录更正。"], tips: ["关闭期间禁止新增会影响该期间的分录。", "系统报表只使用 POSTED 日记账，不把草稿当成账簿事实。"] },
    en: { title: "Chart of accounts and journals", summary: "Create balanced entries and correct posted evidence with explicit reversals.", steps: ["In Accounting, verify that ledger accounts match their business purpose.", "Create a journal date, description and debit/credit lines; total debits must equal total credits.", "Select an active cost centre or project when management reporting requires it.", "Review the period, accounts, tax explanation and supporting evidence before posting.", "Correct a posted error with a reversal and a new entry."], tips: ["A closed period blocks new entries that affect it.", "Reports use POSTED journals only and never treat drafts as ledger facts."] },
  },
  {
    id: "bank-reconciliation", group: "FINANCE", roles: ["Accountant"],
    zh: { title: "银行对账", summary: "导入本地 CSV、人工确认匹配并锁定零差异工作底稿。", steps: ["从银行下载 CSV，不要修改真实交易参考号。", "在 Bank reconciliation 选择银行科目、期间、期初和期末余额后导入。", "验证 CSV 行和余额算术。", "逐条审核系统建议并人工确认，不会自动匹配。", "处理未清项目，只有差异为零才能完成并锁定。"], tips: ["这不是实时银行连接，也不证明结算。", "完成后的工作底稿保存当时已清和未清快照。"] },
    en: { title: "Bank reconciliation", summary: "Import a local CSV, confirm matches manually and lock a zero-difference working paper.", steps: ["Download a CSV from the bank without changing genuine transaction references.", "In Bank reconciliation choose the bank account, period, opening and closing balance, then import.", "Validate statement rows and balance arithmetic.", "Review every suggestion and confirm manually; suggestions never auto-match.", "Resolve uncleared items; completion is allowed only at zero difference."], tips: ["This is not a live bank feed and does not prove settlement.", "A completed working paper freezes the cleared and uncleared snapshot reviewed at that time."] },
  },
  {
    id: "month-close", group: "FINANCE", roles: ["Accountant", "Owner"],
    zh: { title: "月结与重开", summary: "完成完整性检查，顺序锁定期间并由 Owner 受控重开。", steps: ["在 Period close 选择最早尚未关闭月份。", "完成银行对账、日记账平衡、应付/应收复核和到期折旧。", "阅读所有阻止项和警告；修正来源记录，不要绕过检查。", "关闭期间并保存快照。", "发现后续调整时仅 Owner 可按倒序重开，完成更正后重新关闭。"], tips: ["关闭操作会再次检查最新数据，防止检查后状态漂移。", "重开不会删除原关闭证据。"] },
    en: { title: "Month-end close and reopen", summary: "Complete integrity checks, lock periods in order and use controlled Owner reopening.", steps: ["In Period close, select the earliest open month.", "Complete bank reconciliation, journal balance, receivable/payable review and due depreciation.", "Read every blocker and warning; correct the source record instead of bypassing it.", "Close the period and retain its snapshot.", "For a later adjustment, only the Owner can reopen in reverse order; post the correction and close again."], tips: ["Closing rechecks current data to prevent drift after the initial review.", "Reopening does not delete prior close evidence."] },
  },
  {
    id: "fixed-assets", group: "FINANCE", roles: ["Accountant"],
    zh: { title: "固定资产", summary: "记录购置、逐月账面折旧和处置的完整会计链。", steps: ["建立资产编号、类别、购置日期、成本、残值和使用年限。", "选择带会计入账的购置，或明确标记仅迁移登记册。", "每月按顺序运行到期折旧，不可跳月。", "处置时输入日期、收入和说明，系统计算账面价值与损益。", "在总账和资产登记册核对所有生成分录。"], tips: ["账面折旧不是税务资本津贴。", "月结会阻止尚未过账的到期账面折旧。"] },
    en: { title: "Fixed assets", summary: "Maintain the accounting chain for acquisition, monthly book depreciation and disposal.", steps: ["Create an asset number, category, acquisition date, cost, residual value and useful life.", "Choose a posted acquisition or explicitly identify a register-only migration.", "Run due depreciation monthly and sequentially without skipping a period.", "On disposal, enter the date, proceeds and explanation; the system calculates book value and gain or loss.", "Reconcile every generated entry to the general ledger and asset register."], tips: ["Book depreciation is not a tax capital-allowance schedule.", "Month close blocks while due book depreciation is unposted."] },
  },
  {
    id: "budgets-dimensions", group: "FINANCE", roles: ["Manager", "Accountant", "Owner"],
    zh: { title: "预算、成本中心与项目", summary: "控制年度预算版本，并分析不改变法定账簿的管理损益。", steps: ["建立永久成本中心/项目代码；停用不再使用的代码而不是删除历史。", "为费用科目、采购地点或 POS 地点建立精确自动分配规则。", "Accountant/Admin 建立年度收入与费用预算草稿。", "只有 Owner 可批准；新批准版本会取代旧批准版本并锁定。", "查看预算差异和 Dimension P&L，确认未分配活动。"], tips: ["收入高于预算或费用低于预算显示为正向表现。", "维度报告是管理分析，不会改变总账平衡或法定报表。"] },
    en: { title: "Budgets, cost centres and projects", summary: "Control annual budget versions and analyse management profit without changing the statutory ledger.", steps: ["Create permanent cost-centre and project codes; archive unused codes rather than deleting history.", "Create exact automatic allocation rules for expense accounts, purchase locations or POS locations.", "An Accountant or Admin creates an annual revenue-and-expense budget draft.", "Only the Owner approves; a newly approved version supersedes and locks the previous approved version.", "Review budget variance and Dimension P&L, including unassigned activity."], tips: ["Revenue above budget or expense below budget is shown as positive performance.", "Dimension reporting is management analysis and does not change ledger balance or statutory statements."] },
  },
  {
    id: "reports", group: "FINANCE", roles: ["Manager", "Accountant"],
    zh: { title: "财务、经营与国家报告", summary: "从已过账账簿导出报表，同时理解工作底稿边界。", steps: ["在 Reports 选择日期范围并运行损益、资产负债表、试算表、现金流或业务分析。", "从汇总数字向下检查相关明细。", "导出 CSV 或打印为 PDF 并记录使用期间。", "Country report desk 可准备特定地区的管理工作底稿。", "电子发票功能可生成加密 UBL/JSON/MyInvois 准备文件。"], tips: ["国家报告不是经认证报税表。", "当前电子发票文件不代表数字签名、税局提交或接受。"] },
    en: { title: "Financial, operating and country reports", summary: "Export reports from the posted ledger while understanding working-paper boundaries.", steps: ["In Reports choose a date range and run profit and loss, balance sheet, trial balance, cash flow or operating analysis.", "Drill from summary values into the relevant detail.", "Export CSV or print to PDF and record the covered period.", "The Country report desk prepares selected regional management working papers.", "Electronic-invoice tools prepare encrypted UBL, JSON and limited MyInvois files."], tips: ["Country reports are not certified tax returns.", "Prepared e-invoice files do not prove digital signature, tax-authority submission or acceptance."] },
  },
  {
    id: "workspace", group: "ADMIN", roles: ["Owner", "Admin"],
    zh: { title: "工作区、门店、付款与模板", summary: "集中维护未来交易所使用的业务设置。", steps: ["在 Workspace 维护公司、地区、税务显示、联系方式和文档资料。", "在 Locations 建立门店、仓库和层级；在 Counters 分配门店柜台。", "在 Payment methods 控制可用付款类型和顺序。", "维护收据与发票模板并先预览打印效果。", "设置更改后执行一笔测试交易，确认税、币种、日期与模板。"], tips: ["地区设置不会重新标记历史金额。", "归档主数据比删除更安全，历史记录继续显示快照。"] },
    en: { title: "Workspace, locations, payments and templates", summary: "Centrally maintain business settings used by future transactions.", steps: ["In Workspace maintain company, regional, tax-display, contact and document details.", "Create shops, warehouses and hierarchy in Locations, then assign shop counters in Counters.", "Control available payment types and order in Payment methods.", "Maintain receipt and invoice templates and preview their printed output.", "After a setting change, run a test transaction and verify tax, currency, dates and templates."], tips: ["Regional changes do not relabel historical money.", "Archiving master data is safer than deletion and history continues to show its snapshot."] },
  },
  {
    id: "team-security", group: "ADMIN", roles: ["Owner", "Admin"],
    zh: { title: "团队、安全与 Owner 恢复", summary: "维护独立账号、强制密码更新和受控所有权。", steps: ["在 Team & access 为每人建立独立账号和最小权限角色。", "新账号使用临时密码并在首次登录强制更改。", "人员离职时立即停用，不要把账号改名给新人。", "Owner 定期检查敏感配置、恢复方式和所有权转移请求。", "需要恢复时使用专用 Owner recovery 流程并保留审计。"], tips: ["系统不会在普通界面返回原始 Token、Webhook Secret 或数据库凭证。", "所有权转移与关闭公司属于 Owner 专属控制。"] },
    en: { title: "Team, security and Owner recovery", summary: "Maintain individual accounts, forced password change and controlled ownership.", steps: ["In Team & access, create an individual account and least-privilege role for each person.", "Issue a temporary password and require a change at first sign-in.", "Disable a leaver immediately; never rename the account for a new employee.", "The Owner periodically reviews sensitive configuration, recovery and ownership-transfer requests.", "Use the dedicated Owner recovery flow when necessary and retain its audit evidence."], tips: ["Ordinary screens never return raw tokens, webhook secrets or database credentials.", "Ownership transfer and company shutdown are Owner-only controls."] },
  },
  {
    id: "audit-retention", group: "ADMIN", roles: ["Owner", "Admin", "Accountant"],
    zh: { title: "审计、例外与数据保留", summary: "复核高风险事件，并按政策清理非财务操作数据。", steps: ["在 Reviews 查看销售、库存、付款或权限产生的例外。", "记录调查结果、负责人和解决说明后再关闭例外。", "使用审计记录确认谁在何时执行了关键动作。", "在 Maintenance 预览保留策略影响后再执行允许的清理。", "财务证据、已开单据和必要附件不会通过普通保留流程硬删除。"], tips: ["清理前先备份并记录批准。", "审计日志不是替代管理复核，而是复核证据。"] },
    en: { title: "Audit, exceptions and retention", summary: "Review high-risk events and apply policy to non-financial operational data.", steps: ["Use Reviews to inspect exceptions from sales, stock, payments or access.", "Record the investigation, owner and resolution before closing an exception.", "Use audit evidence to confirm who performed a critical action and when.", "In Maintenance, preview retention impact before running an allowed cleanup.", "Financial evidence, issued documents and required attachments are not hard-deleted by ordinary retention work."], tips: ["Back up and record approval before cleanup.", "Audit logs support management review; they do not replace it."] },
  },
  {
    id: "troubleshooting", group: "ADMIN", roles: ["All users"],
    zh: { title: "故障处理与求助", summary: "用安全步骤处理加载、权限、重复提交、扫描和附件问题。", steps: ["页面加载慢时先等待当前操作完成，再刷新一次；不要连续提交付款或结账。", "收到 Session expired 时重新登录；重复出现则让 Admin 检查账号状态。", "权限错误先确认角色和门店职责，不要索取共用管理员账号。", "扫描/NFC 无响应时检查设备权限、会话是否过期和凭证是否仍有效。", "附件无法预览时尝试下载；仍失败则记录索赔编号、文件名、时间和错误提示交给 Owner。", "向支持人员提供单据编号、发生时间和可公开的错误信息，绝不要发送密码或 Token。"], tips: ["数据库或部署问题通常会显示安全的公共错误；详细凭证只应在受控后台检查。", "恢复后检查是否已生成收据、账单或付款，避免重复记录。"] },
    en: { title: "Troubleshooting and support", summary: "Handle loading, access, duplicate submission, scanning and evidence issues safely.", steps: ["If a page is slow, let the current action finish and refresh once; do not repeatedly submit payments or checkout.", "If the session expired, sign in again; repeated expiry should be checked by an Admin against account status.", "For an access error, confirm role and location duties instead of requesting a shared administrator account.", "If scanning or NFC does not respond, check device permission, session expiry and credential status.", "If evidence cannot preview, try download; if that also fails, give the Owner the claim number, file name, time and error message.", "Give support the document number, occurrence time and safe error text; never send a password or token."], tips: ["Database or deployment faults normally show a safe public error; credentials belong only in controlled administration.", "After recovery, check whether a receipt, bill or payment already exists before entering it again."] },
  },
  {
    id: "boundaries", group: "ADMIN", roles: ["All users"],
    zh: { title: "重要边界", summary: "了解系统能证明什么，以及哪些事项仍需银行、税局或专业人员确认。", steps: ["付款显示、二维码和本地通知不是银行结算证明。", "送货状态不是承运商或客户签收证明。", "客户 Statement 和供应商付款记录必须通过外部对账确认。", "国家报告、SST/税务数字和电子发票文件属于管理工作底稿。", "正式申报、税务资本津贴、工资法定计算和 MyInvois 提交需经过对应模块、官方接口和专业复核。"], tips: ["重要申报由合资格会计师或税务顾问复核。", "系统控制降低操作风险，但不能替代真实授权和外部确认。"] },
    en: { title: "Important boundaries", summary: "Understand what the system proves and what still needs bank, authority or professional confirmation.", steps: ["A payment display, QR code or local notification is not proof of bank settlement.", "A delivery status is not carrier or customer proof of receipt.", "Customer statements and supplier payment records require external reconciliation.", "Country reports, SST/tax figures and e-invoice files are management working papers.", "Formal filing, tax capital allowances, statutory payroll and MyInvois submission require the relevant module, official interface and professional review."], tips: ["Have a qualified accountant or tax adviser review important filings.", "System controls reduce operating risk but do not replace real authority and external confirmation."] },
  },
];
