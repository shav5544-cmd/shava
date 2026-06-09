WITH bakt0_raw AS (
    /*+ MATERIALIZE */
    SELECT /*+ PARALLEL(lp, 4) */
        lp.dealid,
        lp.siteid,
        lp.dealtypeid,
        lp.contragentid,
        lp.contragentname,
        lp.DEALNO,
        lp.toboid,
        lp.tobo_sname,
        lp.COMMERCIALLOANTYPEID,
        ltp.LOANTYPENAME                                        AS loantypename,
        lp.commercialloantypeid || '-' || lntp.DESCRIPTION     AS comm_loantype_desc,

        CASE
            WHEN r.rate IS NULL
            THEN (
                (CASE WHEN lp.principalaccountno = lp.rolloveraccountno
                           OR lp.principalaccountno IS NULL
                      THEN 0
                      ELSE NVL(lp.principalamounteq, 0)
                 END)
                + lp.OVERDUEAMOUNTEQ
                + lp.CLAIMPRINCIPALAMOUNTEQ
                + ABS(lp.REVISEDPRINCIPALAMOUNTEQ)
                + ABS(lp.REVISEDROLLOVERAMOUNTEQ)
                + lp.CLAIMOVERDUEAMOUNTEQ
                + CASE WHEN lp.Revisedrolloveraccno = lp.rolloveraccountno
                            OR lp.rolloveraccountno IS NULL
                       THEN 0
                       ELSE lp.ROLLOVERAMOUNTEQ
                  END
            ) / 100
            ELSE
            (
                (CASE WHEN lp.PRINCIPALACCOUNTNO = lp.ROLLOVERACCOUNTNO
                           OR lp.PRINCIPALACCOUNTNO IS NULL
                      THEN 0
                      ELSE NVL(lp.PRINCIPALAMOUNT, 0)
                 END)
                + lp.OVERDUEAMOUNT
                + lp.CLAIMPRINCIPALAMOUNT
                + ABS(lp.REVISEDPRINCIPALAMOUNT)
                + ABS(lp.REVISEDROLLOVERAMOUNT)
                + lp.CLAIMOVERDUEAMOUNT
                + CASE WHEN lp.REVISEDROLLOVERACCNO = lp.ROLLOVERACCOUNTNO
                            OR lp.ROLLOVERACCOUNTNO IS NULL
                       THEN 0
                       ELSE lp.ROLLOVERAMOUNT
                  END
            ) * r.rate / r.base / 100
        END AS od_sum_mahraj

    FROM creator_k.Loan_Portfolio_Best lp

    LEFT JOIN creator_k.currencyrateall r
        ON  r.arcdate    = DATE '2026-04-30'
        AND r.currencyid = lp.currencyid

    -- ✅ ФАҚАТ siteid = 1158 УЧУН JOIN
    LEFT JOIN datamarts.fact_count_days_overdue f
        ON  f."Код сделки Кредита" = lp.dealid
        AND f."МФО"                = lp.siteid
        AND f."Дата отчета"        = DATE '2026-04-30'
        AND lp.siteid              = 1158

    LEFT JOIN creator_k.loanrequestuz      rq   ON rq.dealid        = lp.dealid
    LEFT JOIN creator_k.loantype           ltp  ON ltp.loantypecode = rq.loantype
    LEFT JOIN creator_k.commercialloantype lntp ON lntp.ID          = lp.COMMERCIALLOANTYPEID

    WHERE lp.arcdate    = DATE '2026-04-30'
      AND lp.dealtypeid IN (355, 356)
      AND lp.toboid     <> 1
      AND (lp.commercialloantypeid || '-' || lntp.DESCRIPTION)
                         NOT LIKE '%Реализация залога%'

      -- ✅ 1158 → fact_count_days_overdue, ҚОЛГАНЛАР → Loan_Portfolio_Best
      AND CASE
              WHEN lp.siteid = 1158
              THEN NVL(f."Макс.дни просрочки", 0)
              ELSE NVL(lp.overdue_days_max, 0)
          END = 0
),

bakt0_start AS (
    /*+ MATERIALIZE */
    SELECT *
    FROM bakt0_raw
    WHERE od_sum_mahraj > 0
),

mahraj_total AS (
    /*+ MATERIALIZE */
    SELECT SUM(od_sum_mahraj) AS mahraj_sum
    FROM bakt0_start
),

first_dpd1 AS (
    /*+ MATERIALIZE */

    -- ✅ МФО 1158 → fact_count_days_overdue
    SELECT /*+ USE_HASH(b) */
        b.dealid,
        b.siteid,
        MIN(f."Дата отчета") AS first_overdue_date
    FROM bakt0_start b
    JOIN datamarts.fact_count_days_overdue f
        ON  f."Код сделки Кредита" = b.dealid
        AND f."МФО"                = b.siteid
        AND f."Дата отчета"        BETWEEN DATE '2026-05-01'
                                       AND DATE '2026-05-31'
        AND f."Макс.дни просрочки" >= 1
    WHERE b.siteid = 1158                              -- ✅ ФАҚАТ 1158
    GROUP BY b.dealid, b.siteid

    UNION ALL

    -- ✅ ҚОЛГАН МФО → Loan_Portfolio_Best
    SELECT /*+ PARALLEL(lp2, 4) USE_HASH(b) */
        b.dealid,
        b.siteid,
        MIN(lp2.arcdate) AS first_overdue_date
    FROM bakt0_start b
    JOIN creator_k.Loan_Portfolio_Best lp2
        ON  lp2.dealid  = b.dealid
        AND lp2.siteid  = b.siteid
        AND lp2.arcdate BETWEEN DATE '2026-05-01'
                            AND DATE '2026-05-31'
        AND NVL(lp2.overdue_days_max, 0) >= 1
        AND lp2.dealtypeid IN (355, 356)
    WHERE b.siteid <> 1158                             -- ✅ 1158 ДАН ТАШҚАРИ
    GROUP BY b.dealid, b.siteid
),

surat AS (
    /*+ MATERIALIZE */
    SELECT /*+ PARALLEL(lp3, 4) USE_HASH(b) USE_HASH(fd) */
        fd.dealid,
        fd.siteid,
        fd.first_overdue_date,
        b.contragentname,
        b.DEALNO,
        b.toboid,
        b.tobo_sname,
        b.contragentid,
        b.od_sum_mahraj,
        b.loantypename,
        b.comm_loantype_desc,

        CASE
            WHEN fd.siteid = 1158
            -- ✅ 1158 → LPB ДА КУНЛИК SNAPSHOT ЙЎҚ → 30.04 ОД ИШЛАТ
            THEN b.od_sum_mahraj
            -- ✅ ҚОЛГАН МФО → LPB ДА ШУ КУН БОР
            ELSE
                CASE
                    WHEN r3.rate IS NULL
                    THEN (
                        (CASE WHEN lp3.principalaccountno = lp3.rolloveraccountno
                                   OR lp3.principalaccountno IS NULL
                              THEN 0
                              ELSE NVL(lp3.principalamounteq, 0)
                         END)
                        + lp3.OVERDUEAMOUNTEQ
                        + lp3.CLAIMPRINCIPALAMOUNTEQ
                        + ABS(lp3.REVISEDPRINCIPALAMOUNTEQ)
                        + ABS(lp3.REVISEDROLLOVERAMOUNTEQ)
                        + lp3.CLAIMOVERDUEAMOUNTEQ
                        + CASE WHEN lp3.Revisedrolloveraccno = lp3.rolloveraccountno
                                    OR lp3.rolloveraccountno IS NULL
                               THEN 0
                               ELSE lp3.ROLLOVERAMOUNTEQ
                          END
                    ) / 100
                    ELSE
                    (
                        (CASE WHEN lp3.PRINCIPALACCOUNTNO = lp3.ROLLOVERACCOUNTNO
                                   OR lp3.PRINCIPALACCOUNTNO IS NULL
                              THEN 0
                              ELSE NVL(lp3.PRINCIPALAMOUNT, 0)
                         END)
                        + lp3.OVERDUEAMOUNT
                        + lp3.CLAIMPRINCIPALAMOUNT
                        + ABS(lp3.REVISEDPRINCIPALAMOUNT)
                        + ABS(lp3.REVISEDROLLOVERAMOUNT)
                        + lp3.CLAIMOVERDUEAMOUNT
                        + CASE WHEN lp3.REVISEDROLLOVERACCNO = lp3.ROLLOVERACCOUNTNO
                                    OR lp3.ROLLOVERACCOUNTNO IS NULL
                               THEN 0
                               ELSE lp3.ROLLOVERAMOUNT
                          END
                    ) * r3.rate / r3.base / 100
                END
        END AS od_sum_surat

    FROM first_dpd1 fd
    JOIN bakt0_start b
        ON  b.dealid = fd.dealid
        AND b.siteid = fd.siteid

    -- ✅ ФАҚАТ 1158 ДАН ТАШҚАРИ УЧУН LPB JOIN
    LEFT JOIN creator_k.Loan_Portfolio_Best lp3
        ON  lp3.dealid  = fd.dealid
        AND lp3.siteid  = fd.siteid
        AND lp3.arcdate = fd.first_overdue_date
        AND fd.siteid  <> 1158                   -- ✅ 1158 УЧУН JOIN ИШЛАМАЙДИ

    LEFT JOIN creator_k.currencyrateall r3
        ON  r3.arcdate    = DATE '2026-04-30'
        AND r3.currencyid = lp3.currencyid
),

surat_total AS (
    /*+ MATERIALIZE */
    SELECT SUM(od_sum_surat) AS surat_sum
    FROM surat
)

SELECT /*+ PARALLEL(4) */
    s.dealid                        AS "Код сделки",
    s.DEALNO                        AS "Номер договора",
    s.contragentid                  AS "Код контрагента",
    s.contragentname                AS "Наименование клиента",
    s.loantypename                  AS "Описание типа кредита",
    s.comm_loantype_desc            AS "Описание типа коммерческого кредита",
    DATE '2026-04-30'               AS "Дата знаменателя",
    s.first_overdue_date            AS "Дата первого выхода в 1+",
    s.od_sum_mahraj                 AS "Остаток ОД на 30.04.2026",
    s.od_sum_surat                  AS "Остаток ОД на дату выхода",
    NULL                            AS "Итого ОД бакет 0 на 30.04.2026 (знаменатель)",
    NULL                            AS "Итого ОД вышедших в 1+ за май 2026 (числитель)",
    NULL                            AS "Inflow Rate, %",
    1                               AS sort_order
FROM surat s

UNION ALL

SELECT /*+ PARALLEL(4) */
    NULL                            AS "Код сделки",
    '★ ИТОГО INFLOW RATE'          AS "Номер договора",
    NULL                            AS "Код контрагента",
    'МАЙ 2026 (355+356)'           AS "Наименование клиента",
    NULL                            AS "Описание типа кредита",
    NULL                            AS "Описание типа коммерческого кредита",
    DATE '2026-04-30'               AS "Дата знаменателя",
    DATE '2026-05-31'               AS "Дата первого выхода в 1+",
    m.mahraj_sum                    AS "Остаток ОД на 30.04.2026",
    st.surat_sum                    AS "Остаток ОД на дату выхода",
    m.mahraj_sum                    AS "Итого ОД бакет 0 на 30.04.2026 (знаменатель)",
    st.surat_sum                    AS "Итого ОД вышедших в 1+ за май 2026 (числитель)",
    ROUND(
        st.surat_sum / NULLIF(m.mahraj_sum, 0) * 100, 2
    )                               AS "Inflow Rate, %",
    2                               AS sort_order

FROM mahraj_total m
CROSS JOIN surat_total st

ORDER BY sort_order, "Дата первого выхода в 1+";
