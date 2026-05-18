with
/* Портфель кредитов по датам */
portfolio_params as
(
  select /*+ parallel(4) */
    alm.*,
    ov."Макс.дни просрочки" as count_days_overdue,
    (case
       when nvl(ov."Макс.дни просрочки",0) = 0 then '0'
       when nvl(ov."Макс.дни просрочки",0) between 1 and 30 then '1 - 30'
       when nvl(ov."Макс.дни просрочки",0) between 31 and 60 then '31 - 60'
       when nvl(ov."Макс.дни просрочки",0) between 61 and 90 then '61 - 90'
       when nvl(ov."Макс.дни просрочки",0) between 91 and 120 then '91 - 120'
       when nvl(ov."Макс.дни просрочки",0) between 121 and 150 then '121 - 150'
       when nvl(ov."Макс.дни просрочки",0) between 151 and 180 then '151 - 180'
       when nvl(ov."Макс.дни просрочки",0) between 181 and 210 then '181 - 210'
       when nvl(ov."Макс.дни просрочки",0) between 211 and 240 then '211 - 240'
       when nvl(ov."Макс.дни просрочки",0) between 241 and 270 then '241 - 270'
       when nvl(ov."Макс.дни просрочки",0) between 271 and 300 then '271 - 300'
       when nvl(ov."Макс.дни просрочки",0) between 301 and 330 then '301 - 330'
       when nvl(ov."Макс.дни просрочки",0) between 331 and 360 then '331 - 360'
       when nvl(ov."Макс.дни просрочки",0) >= 361 then '361+'
     end) as days_bucket
  from
  (
    select /*+ parallel(alp 4) parallel(dcr 4) */
      alp.arcdate,
      alp.dealid,
      alp.currencyid,
      alp.contragentid,
      dcr.rate,
      dcr.arcdate as rate_date
    from b2_olap_uz.ar_loanportfolio alp
    left join CREATOR_K.CURRENCYRATEALL dcr
      on alp.currencyid = dcr.currencyid
     and dcr.arcdate   = trunc(sysdate, 'dd') - 1
    where alp.arcdate >= trunc(to_date(:p_start_date, 'dd.mm.yyyy'), 'dd')
      and alp.arcdate <= trunc(to_date(:p_end_date, 'dd.mm.yyyy'), 'dd')
      and alp.dealid = :p_dealid
  ) alm
  left join datamarts.fact_count_days_overdue ov /*+ parallel(ov 4) */
    on ov."Код сделки Кредита" = alm.dealid
   and ov."Дата отчета"        = alm.arcdate - 1
),

/* Связь со сделками AIK */
deal_link as
(
  select /*+ parallel(dl 4) */ dl.dealid1 as dealid, dl.dealid2 as AIK_dealid
  from (select distinct dealid from portfolio_params) lp
  join CREATOR_K.DEALLINK dl
    on dl.dealid1   = lp.dealid
   and dl.linktypeid = 35002
  group by dl.dealid2, dl.dealid1
),

/* Сопоставление кредитной сделки с договорами / траншами */
Loan_deals as
(
  select /*+ parallel(trn 4) */
         trn.dealid,
         trn.loandealid,
         trn.currencyid
  from b2_olap_uz.dim_dealcommercialtranche trn
  where trn.sourcesystemid = 50
    and trn.loandealid in (select distinct dealid from portfolio_params)

  union all

  select /*+ parallel(ant 4) parallel(us 4) parallel(lk 4) */
         us.AIK_dealid as dealid,
         us.dealid    as loandealid,
         ant.currencyid
  from creator_k.aaccount_int ant
  left join
  (
    select us.accountid, lk.dealid, lk.AIK_dealid
    from deal_link lk
    join CREATOR_K.DEALACCOUNTINUSE us
      on us.dealid = lk.AIK_dealid
    group by us.accountid, lk.dealid, lk.AIK_dealid
  ) us
    on us.accountid = ant.id
  where nvl(ant.dateclose, trunc(to_date(:p_end_date, 'dd.mm.yyyy'), 'dd'))
          >= trunc(to_date(:p_start_date, 'dd.mm.yyyy'), 'dd')
    and ant.baccountid = 16405
),

/* Транзакции по сделкам (без ограничительных фильтров) */
transactions as
(
  select /*+ parallel(dtr 4) parallel(tr 4) parallel(r 4) parallel(tp 4) */
    dtr.arcdate,
    dtr.siteid,
    lp.dealid,
    tr.dealid as tranche_dealid,
    dtr.accountid,
    sum(dtr.usesumma * r.rate / r.base)/100 as summa
  from (select distinct dealid from portfolio_params) lp
  join Loan_deals tr
    on tr.loandealid = lp.dealid
  join CREATOR_K.DEALDOCTRANSACTION dtr
    on tr.dealid = dtr.dealid
  left join CREATOR_K.CURRENCYRATEALL r
    on r.arcdate   = dtr.arcdate
   and r.currencyid = tr.currencyid
  left join CREATOR_K.DEALDOCUMENTTYPE tp
    on tp.id = dtr.dealdocumenttypeid
  where dtr.arcdate >= trunc(to_date(:p_start_date, 'dd.mm.yyyy'), 'dd')
    and dtr.arcdate <= trunc(to_date(:p_end_date, 'dd.mm.yyyy'), 'dd')
  group by dtr.arcdate, dtr.siteid, lp.dealid, tr.dealid, dtr.accountid
),

/* Все балансовые счета */
account_filtered as
(
  select /*+ parallel(al 4) */
    al.id           as accountid,
    al.siteid,
    al.baccountid,
    al.accountno    as full_account_code
  from creator_k.aaccount_int al
  where nvl(al.dateclose, trunc(to_date(:p_end_date, 'dd.mm.yyyy'), 'dd'))
          >= trunc(to_date(:p_start_date, 'dd.mm.yyyy'), 'dd')
),

/* Агрегат транзакций с учётом baccountid */
transaction_select as
(
  select /*+ parallel(trn 4) parallel(af 4) */
    trn.arcdate,
    trn.dealid,
    trn.tranche_dealid,
    trn.siteid,
    af.baccountid,
    af.full_account_code,
    sum(trn.summa) as paidamount
  from transactions trn
  join account_filtered af
    on af.accountid = trn.accountid
   and af.siteid   = trn.siteid
  group by
    trn.dealid,
    trn.tranche_dealid,
    trn.siteid,
    trn.arcdate,
    af.baccountid,
    af.full_account_code
)

/* ИТОГ: полный оборот по анкете за период */
select /*+ parallel(p 4) parallel(t 4) */
  p.dealid,
  t.tranche_dealid as tranche_no,
  p.contragentid,
  t.baccountid,
  t.full_account_code as account_no,
  min(p.arcdate) as first_arcdate,
  max(p.arcdate) as last_arcdate,
  max(p.days_bucket) keep (dense_rank last order by p.arcdate) as last_days_bucket,
  sum(nvl(t.paidamount, 0)) as paidamount_total
from portfolio_params p
left join transaction_select t
  on t.dealid  = p.dealid
 and t.arcdate = p.arcdate
where p.arcdate >= trunc(to_date(:p_start_date, 'dd.mm.yyyy'), 'dd')
  and p.arcdate <= trunc(to_date(:p_end_date, 'dd.mm.yyyy'), 'dd')
group by
  p.dealid,
  t.tranche_dealid,
  p.contragentid,
  t.baccountid,
  t.full_account_code
order by
  p.dealid,
  t.tranche_dealid,
  t.baccountid;
