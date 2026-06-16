WITH

-- ================================================
-- 1. LPB ЕЖЕДНЕВНО: ОД гибридный (AR до 15.04, LPB с 15.04)
--    + тип кредита + тип контрагента
-- ================================================
lpb_daily AS (
    /*+ MATERIALIZE */
    SELECT /*+ PARALLEL(lp, 4) */
        lp.dealid,
        lp.siteid,
        lp.arcdate,
        NVL(lp.overdue_days_max, 0) AS overdue_days_lpb,
        CASE
            -- ДО 15.04: ОД из AR_LOANPORTFOLIO
            WHEN lp.arcdate < DATE '2026-04-15'
            THEN
                CASE
                    WHEN ar.REVISEDROLLOVERAMOUNTEQ < 0
                    THEN (ar.ROLLOVERAMOUNTEQ + ar.OVERDUEAMOUNTEQ + ar.CLAIMPRINCIPALAMOUNTEQ
                          + ar.CLAIMOVERDUEAMOUNTEQ + (ar.REVISEDROLLOVERAMOUNTEQ * -1)) / 100
                    ELSE (ar.RESTAMOUNTEQ - ar.HOPELESSAMOUNTEQ - ar.HOPELESSOVERDUEAMOUNTEQ) / 100
                END
            -- С 15.04: формула Loan_Portfolio_Best (сумовые)
            WHEN r.rate IS NULL OR lp.currencyid = 0
            THEN (
                (CASE WHEN lp.principalaccountno = lp.rolloveraccountno
                           OR lp.principalaccountno IS NULL
                      THEN 0 ELSE NVL(lp.principalamounteq, 0) END)
                + lp.OVERDUEAMOUNTEQ + lp.CLAIMPRINCIPALAMOUNTEQ
                + ABS(lp.REVISEDPRINCIPALAMOUNTEQ) + ABS(lp.REVISEDROLLOVERAMOUNTEQ)
                + lp.CLAIMOVERDUEAMOUNTEQ
                + CASE WHEN lp.Revisedrolloveraccno = lp.rolloveraccountno
                            OR lp.rolloveraccountno IS NULL
                       THEN 0 ELSE lp.ROLLOVERAMOUNTEQ END
            ) / 100
            -- С 15.04: валютные
            ELSE (
                (CASE WHEN lp.PRINCIPALACCOUNTNO = lp.ROLLOVERACCOUNTNO
                           OR lp.PRINCIPALACCOUNTNO IS NULL
                      THEN 0 ELSE NVL(lp.PRINCIPALAMOUNT, 0) END)
                + lp.OVERDUEAMOUNT + lp.CLAIMPRINCIPALAMOUNT
                + ABS(lp.REVISEDPRINCIPALAMOUNT) + ABS(lp.REVISEDROLLOVERAMOUNT)
                + lp.CLAIMOVERDUEAMOUNT
                + CASE WHEN lp.REVISEDROLLOVERACCNO = lp.ROLLOVERACCOUNTNO
                            OR lp.ROLLOVERACCOUNTNO IS NULL
                       THEN 0 ELSE lp.ROLLOVERAMOUNT END
            ) * r.rate / r.base / 100
        END AS od_sum,
        t4.LOANTYPENAME                 AS loantype_name,
        TRIM(TO_CHAR(c.CONTRAGENTTYPEID)) AS contragent_type
    FROM creator_k.Loan_Portfolio_Best lp
    LEFT JOIN creator_k.currencyrateall r
        ON  r.arcdate    = lp.arcdate
        AND r.currencyid = lp.currencyid
    LEFT JOIN creator_k.commercialloantype lntp
        ON lntp.ID = lp.COMMERCIALLOANTYPEID
    LEFT JOIN B2_OLAP_UZ.AR_LOANPORTFOLIO ar
        ON  ar.dealid  = lp.dealid
        AND ar.siteid  = lp.siteid
        AND ar.arcdate = lp.arcdate
        AND lp.arcdate < DATE '2026-04-15'
    LEFT JOIN B2_OLAP_UZ.DIM_UZ_LOANREQUEST t4
        ON t4.DEALID = lp.dealid
    LEFT JOIN creator_k.contragent c
        ON c.id = lp.contragentid AND c.siteid = lp.siteid
    WHERE lp.arcdate    BETWEEN DATE '2026-04-01' AND DATE '2026-05-26'
      AND lp.dealtypeid IN (355, 356)
      AND lp.toboid     <> 1
      AND (lp.commercialloantypeid || '-' || lntp.DESCRIPTION)
                         NOT LIKE '%Реализация залога%'
),

-- ================================================
-- 2. ФАКТ ЕЖЕДНЕВНО
-- ================================================
fact_daily AS (
    /*+ MATERIALIZE */
    SELECT
        f."Код сделки Кредита"  AS dealid,
        f."МФО"                 AS siteid,
        f."Дата отчета"         AS arcdate,
        f."Макс.дни просрочки"  AS overdue_days
    FROM datamarts.fact_count_days_overdue f
    WHERE f."Дата отчета" BETWEEN DATE '2026-04-01' AND DATE '2026-05-26'
      AND EXISTS (
            SELECT 1 FROM lpb_daily l
            WHERE l.dealid = f."Код сделки Кредита"
              AND l.siteid = f."МФО"
      )
),

-- ================================================
-- 3. БАЗА 31.03 (только для LAG)
-- ================================================
march_base AS (
    /*+ MATERIALIZE */
    SELECT /*+ PARALLEL(lp, 4) */
        lp.dealid,
        lp.siteid,
        DATE '2026-03-31' AS arcdate,
        NVL(f."Макс.дни просрочки", NVL(lp.overdue_days_max, 0)) AS overdue_days,
        CAST(NULL AS NUMBER)        AS od_sum,
        CAST(NULL AS VARCHAR2(200)) AS loantype_name,
        CAST(NULL AS VARCHAR2(50))  AS contragent_type
    FROM creator_k.Loan_Portfolio_Best lp
    LEFT JOIN datamarts.fact_count_days_overdue f
        ON  f."Код сделки Кредита" = lp.dealid
        AND f."МФО"                = lp.siteid
        AND f."Дата отчета"        = DATE '2026-03-31'
    LEFT JOIN creator_k.commercialloantype lntp ON lntp.ID = lp.COMMERCIALLOANTYPEID
    WHERE lp.arcdate    = DATE '2026-03-31'
      AND lp.dealtypeid IN (355, 356)
      AND lp.toboid     <> 1
      AND (lp.commercialloantypeid || '-' || lntp.DESCRIPTION)
                         NOT LIKE '%Реализация залога%'
),

-- ================================================
-- 4. ОБЪЕДИНЁННЫЕ ДАННЫЕ (FULL OUTER)
-- ================================================
combined AS (
    SELECT
        NVL(l.dealid, f.dealid)                 AS dealid,
        NVL(l.siteid, f.siteid)                 AS siteid,
        NVL(l.arcdate, f.arcdate)               AS arcdate,
        NVL(f.overdue_days, l.overdue_days_lpb) AS overdue_days,
        l.od_sum,
        l.loantype_name,
        l.contragent_type
    FROM lpb_daily l
    FULL OUTER JOIN fact_daily f
        ON  f.dealid  = l.dealid
        AND f.siteid  = l.siteid
        AND f.arcdate = l.arcdate
    UNION ALL
    SELECT dealid, siteid, arcdate, overdue_days, od_sum, loantype_name, contragent_type
    FROM march_base
),

-- ================================================
-- 5. ЕЖЕДНЕВНОЕ СОСТОЯНИЕ + LAG + ЗАПОЛНЕНИЕ
-- ================================================
daily AS (
    SELECT
        c.dealid,
        c.siteid,
        c.arcdate,
        c.overdue_days,
        COALESCE(
            c.od_sum,
            LAST_VALUE(c.od_sum IGNORE NULLS) OVER (
                PARTITION BY c.dealid, c.siteid
                ORDER BY c.arcdate
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ),
            FIRST_VALUE(c.od_sum IGNORE NULLS) OVER (
                PARTITION BY c.dealid, c.siteid
                ORDER BY c.arcdate
                ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
            )
        ) AS od_sum,
        LAST_VALUE(c.loantype_name IGNORE NULLS) OVER (
            PARTITION BY c.dealid, c.siteid
            ORDER BY c.arcdate
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS loantype_name,
        LAST_VALUE(c.contragent_type IGNORE NULLS) OVER (
            PARTITION BY c.dealid, c.siteid
            ORDER BY c.arcdate
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS contragent_type,
        LAG(c.overdue_days) OVER (
            PARTITION BY c.dealid, c.siteid
            ORDER BY c.arcdate
        ) AS prev_overdue_days
    FROM combined c
),

-- ================================================
-- 6. ПОРОГИ ПРОСРОЧКИ
-- ================================================
thresholds AS (
    SELECT   1 AS dpd FROM dual UNION ALL
    SELECT  31        FROM dual UNION ALL
    SELECT  61        FROM dual UNION ALL
    SELECT  91        FROM dual UNION ALL
    SELECT 121        FROM dual UNION ALL
    SELECT 151        FROM dual UNION ALL
    SELECT 181        FROM dual
),

-- ================================================
-- 7. СОБЫТИЯ ВХОДА
-- ================================================
entries AS (
    SELECT
        d.dealid,
        d.siteid,
        t.dpd,
        CASE
            WHEN d.arcdate BETWEEN DATE '2026-04-01' AND DATE '2026-04-30'
                 THEN 'APRIL'
            ELSE 'MAY'
        END AS month_tag,
        MIN(d.arcdate)                                                  AS entry_date,
        MIN(d.od_sum)        KEEP (DENSE_RANK FIRST ORDER BY d.arcdate) AS od_on_entry,
        MIN(d.overdue_days)  KEEP (DENSE_RANK FIRST ORDER BY d.arcdate) AS dpd_on_entry,
        MIN(d.loantype_name) KEEP (DENSE_RANK FIRST ORDER BY d.arcdate) AS loantype_name,
        MIN(d.contragent_type) KEEP (DENSE_RANK FIRST ORDER BY d.arcdate) AS contragent_type
    FROM daily d
    JOIN thresholds t
        ON  d.overdue_days              >= t.dpd
        AND NVL(d.prev_overdue_days, 0) <  t.dpd
    WHERE d.arcdate BETWEEN DATE '2026-04-01' AND DATE '2026-05-26'
    GROUP BY
        d.dealid, d.siteid, t.dpd,
        CASE
            WHEN d.arcdate BETWEEN DATE '2026-04-01' AND DATE '2026-04-30'
                 THEN 'APRIL'
            ELSE 'MAY'
        END
),

-- ================================================
-- 8. ПИВОТ: апрель и май в одной строке
-- ================================================
deal_pivot AS (
    SELECT
        dealid,
        siteid,
        MAX(loantype_name)   AS loantype_name,
        MAX(contragent_type) AS contragent_type,
        MAX(CASE WHEN month_tag = 'APRIL' THEN dpd          END) AS apr_dpd,
        MAX(CASE WHEN month_tag = 'APRIL' THEN entry_date   END)
            KEEP (DENSE_RANK LAST ORDER BY CASE WHEN month_tag = 'APRIL' THEN dpd ELSE -1 END)
                                                                  AS apr_entry_date,
        MAX(CASE WHEN month_tag = 'APRIL' THEN dpd_on_entry END)
            KEEP (DENSE_RANK LAST ORDER BY CASE WHEN month_tag = 'APRIL' THEN dpd ELSE -1 END)
                                                                  AS apr_dpd_on_entry,
        MAX(CASE WHEN month_tag = 'APRIL' THEN od_on_entry  END)
            KEEP (DENSE_RANK LAST ORDER BY CASE WHEN month_tag = 'APRIL' THEN dpd ELSE -1 END)
                                                                  AS apr_od,
        MAX(CASE WHEN month_tag = 'MAY' THEN dpd            END) AS may_dpd,
        MAX(CASE WHEN month_tag = 'MAY' THEN entry_date     END)
            KEEP (DENSE_RANK LAST ORDER BY CASE WHEN month_tag = 'MAY' THEN dpd ELSE -1 END)
                                                                  AS may_entry_date,
        MAX(CASE WHEN month_tag = 'MAY' THEN dpd_on_entry   END)
            KEEP (DENSE_RANK LAST ORDER BY CASE WHEN month_tag = 'MAY' THEN dpd ELSE -1 END)
                                                                  AS may_dpd_on_entry,
        MAX(CASE WHEN month_tag = 'MAY' THEN od_on_entry    END)
            KEEP (DENSE_RANK LAST ORDER BY CASE WHEN month_tag = 'MAY' THEN dpd ELSE -1 END)
                                                                  AS may_od
    FROM entries
    GROUP BY dealid, siteid
),

-- ================================================
-- 9. МАППИНГ ПРОДУКТА (Микрокредит делим по контрагенту)
-- ================================================
deal_final AS (
    SELECT
        p.*,
        CASE
            WHEN p.loantype_name = 'Микрозаем'        THEN 'Микрозайм'
            WHEN p.loantype_name = 'Автокредит'       THEN 'Автокредит'
            WHEN p.loantype_name = 'Ипотечный кредит' THEN 'Ипотека'
            WHEN p.loantype_name = 'Микрокредит' AND p.contragent_type = '8'
                 THEN 'Микрокредит (ФЛ)'
            WHEN p.loantype_name = 'Микрокредит' AND p.contragent_type = '11'
                 THEN 'Микрокредит ИП'
            WHEN p.loantype_name = 'Микрокредит'
                 THEN 'Микрокредит ИП'
            ELSE 'Другие кредиты'
        END AS product_group
    FROM deal_pivot p
)

-- ================================================
-- 10. РЕЗУЛЬТАТ
-- ================================================
SELECT
    p.dealid                                AS "Код сделки",
    p.siteid                                AS "МФО",
    p.product_group                         AS "Продукт",
    p.apr_dpd                               AS "Апрель: Порог DPD",
    CASE p.apr_dpd
        WHEN   1 THEN '1-30'   WHEN  31 THEN '31-60'  WHEN  61 THEN '61-90'
        WHEN  91 THEN '91-120' WHEN 121 THEN '121-150' WHEN 151 THEN '151-180'
        WHEN 181 THEN '180+'
    END                                     AS "Апрель: Бакет",
    p.apr_entry_date                        AS "Апрель: Дата входа",
    p.apr_dpd_on_entry                      AS "Апрель: Дни просрочки",
    ROUND(NVL(p.apr_od, 0), 2)              AS "Апрель: ОД",
    p.may_dpd                               AS "Май: Порог DPD",
    CASE p.may_dpd
        WHEN   1 THEN '1-30'   WHEN  31 THEN '31-60'  WHEN  61 THEN '61-90'
        WHEN  91 THEN '91-120' WHEN 121 THEN '121-150' WHEN 151 THEN '151-180'
        WHEN 181 THEN '180+'
    END                                     AS "Май: Бакет",
    p.may_entry_date                        AS "Май: Дата входа",
    p.may_dpd_on_entry                      AS "Май: Дни просрочки",
    ROUND(NVL(p.may_od, 0), 2)              AS "Май: ОД",
    CASE
        WHEN p.apr_dpd IS NOT NULL AND p.may_dpd = p.apr_dpd + 30
             THEN 'Деградация (числитель)'
        WHEN p.apr_dpd IS NOT NULL AND p.may_dpd IS NULL
             THEN 'Не перешёл (cured)'
        WHEN p.apr_dpd IS NULL AND p.may_dpd IS NOT NULL
             THEN 'Вход только в мае'
        ELSE 'Прочее'
    END                                     AS "Статус"
FROM deal_final p
ORDER BY p.dealid, p.siteid;
