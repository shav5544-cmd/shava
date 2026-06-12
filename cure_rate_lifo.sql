WITH bucket_map AS (
    SELECT '1-30' AS bucket_name, 1 AS entry_threshold, 31 AS next_threshold FROM dual
    UNION ALL
    SELECT '31-60', 31, 61 FROM dual
    UNION ALL
    SELECT '61-90', 61, 91 FROM dual
    UNION ALL
    SELECT '91-120', 91, 121 FROM dual
    UNION ALL
    SELECT '121-150', 121, 151 FROM dual
    UNION ALL
    SELECT '151-180', 151, 181 FROM dual
),

aprel_fact AS (
    /*+ MATERIALIZE */
    SELECT
        f."Код сделки Кредита" AS dealid,
        f."МФО"                AS siteid,
        f."Дата отчета"        AS arcdate,
        f."Макс.дни просрочки" AS overdue_days
    FROM datamarts.fact_count_days_overdue f
    WHERE f."Дата отчета" BETWEEN DATE '2026-04-01' AND DATE '2026-04-30'
),

aprel_lpb AS (
    /*+ MATERIALIZE */
    SELECT
        lp.dealid,
        lp.siteid,
        lp.arcdate,
        NVL(lp.overdue_days_max, 0) AS overdue_days_lpb,
        CASE
            WHEN r.rate IS NULL
            THEN (
                (CASE
                    WHEN lp.principalaccountno = lp.rolloveraccountno
                         OR lp.principalaccountno IS NULL
                    THEN 0
                    ELSE NVL(lp.principalamounteq, 0)
                 END)
                + lp.OVERDUEAMOUNTEQ
                + lp.CLAIMPRINCIPALAMOUNTEQ
                + ABS(lp.REVISEDPRINCIPALAMOUNTEQ)
                + ABS(lp.REVISEDROLLOVERAMOUNTEQ)
                + lp.CLAIMOVERDUEAMOUNTEQ
                + CASE
                    WHEN lp.Revisedrolloveraccno = lp.rolloveraccountno
                         OR lp.rolloveraccountno IS NULL
                    THEN 0
                    ELSE lp.ROLLOVERAMOUNTEQ
                  END
            ) / 100
            ELSE (
                (CASE
                    WHEN lp.PRINCIPALACCOUNTNO = lp.ROLLOVERACCOUNTNO
                         OR lp.PRINCIPALACCOUNTNO IS NULL
                    THEN 0
                    ELSE NVL(lp.PRINCIPALAMOUNT, 0)
                 END)
                + lp.OVERDUEAMOUNT
                + lp.CLAIMPRINCIPALAMOUNT
                + ABS(lp.REVISEDPRINCIPALAMOUNT)
                + ABS(lp.REVISEDROLLOVERAMOUNT)
                + lp.CLAIMOVERDUEAMOUNT
                + CASE
                    WHEN lp.REVISEDROLLOVERACCNO = lp.ROLLOVERACCOUNTNO
                         OR lp.ROLLOVERACCOUNTNO IS NULL
                    THEN 0
                    ELSE lp.ROLLOVERAMOUNT
                  END
            ) * r.rate / r.base / 100
        END AS od_sum
    FROM creator_k.Loan_Portfolio_Best lp
    LEFT JOIN creator_k.currencyrateall r
        ON  r.arcdate    = lp.arcdate
        AND r.currencyid = lp.currencyid
    LEFT JOIN creator_k.commercialloantype lntp
        ON lntp.id = lp.commercialloantypeid
    WHERE lp.arcdate BETWEEN DATE '2026-04-01' AND DATE '2026-04-30'
      AND lp.dealtypeid IN (355, 356)
      AND lp.toboid <> 1
      AND (lp.commercialloantypeid || '-' || lntp.description) NOT LIKE '%Реализация залога%'
),

may_fact AS (
    /*+ MATERIALIZE */
    SELECT
        f."Код сделки Кредита" AS dealid,
        f."МФО"                AS siteid,
        f."Дата отчета"        AS arcdate,
        f."Макс.дни просрочки" AS overdue_days
    FROM datamarts.fact_count_days_overdue f
    WHERE f."Дата отчета" BETWEEN DATE '2026-05-01' AND DATE '2026-05-26'
),

may_lpb AS (
    /*+ MATERIALIZE */
    SELECT
        lp.dealid,
        lp.siteid,
        lp.arcdate,
        NVL(lp.overdue_days_max, 0) AS overdue_days_lpb,
        CASE
            WHEN r.rate IS NULL
            THEN (
                (CASE
                    WHEN lp.principalaccountno = lp.rolloveraccountno
                         OR lp.principalaccountno IS NULL
                    THEN 0
                    ELSE NVL(lp.principalamounteq, 0)
                 END)
                + lp.OVERDUEAMOUNTEQ
                + lp.CLAIMPRINCIPALAMOUNTEQ
                + ABS(lp.REVISEDPRINCIPALAMOUNTEQ)
                + ABS(lp.REVISEDROLLOVERAMOUNTEQ)
                + lp.CLAIMOVERDUEAMOUNTEQ
                + CASE
                    WHEN lp.Revisedrolloveraccno = lp.rolloveraccountno
                         OR lp.rolloveraccountno IS NULL
                    THEN 0
                    ELSE lp.ROLLOVERAMOUNTEQ
                  END
            ) / 100
            ELSE (
                (CASE
                    WHEN lp.PRINCIPALACCOUNTNO = lp.ROLLOVERACCOUNTNO
                         OR lp.PRINCIPALACCOUNTNO IS NULL
                    THEN 0
                    ELSE NVL(lp.PRINCIPALAMOUNT, 0)
                 END)
                + lp.OVERDUEAMOUNT
                + lp.CLAIMPRINCIPALAMOUNT
                + ABS(lp.REVISEDPRINCIPALAMOUNT)
                + ABS(lp.REVISEDROLLOVERAMOUNT)
                + lp.CLAIMOVERDUEAMOUNT
                + CASE
                    WHEN lp.REVISEDROLLOVERACCNO = lp.ROLLOVERACCOUNTNO
                         OR lp.ROLLOVERACCOUNTNO IS NULL
                    THEN 0
                    ELSE lp.ROLLOVERAMOUNT
                  END
            ) * r.rate / r.base / 100
        END AS od_sum
    FROM creator_k.Loan_Portfolio_Best lp
    LEFT JOIN creator_k.currencyrateall r
        ON  r.arcdate    = lp.arcdate
        AND r.currencyid = lp.currencyid
    LEFT JOIN creator_k.commercialloantype lntp
        ON lntp.id = lp.commercialloantypeid
    WHERE lp.arcdate BETWEEN DATE '2026-05-01' AND DATE '2026-05-26'
      AND lp.dealtypeid IN (355, 356)
      AND lp.toboid <> 1
      AND (lp.commercialloantypeid || '-' || lntp.description) NOT LIKE '%Реализация залога%'
),

portfolio_base AS (
    /*+ MATERIALIZE */
    SELECT
        l.dealid,
        l.siteid,
        MAX(CASE
                WHEN l.arcdate = DATE '2026-04-30'
                THEN l.od_sum
            END) AS od_sum_apr30
    FROM aprel_lpb l
    GROUP BY
        l.dealid,
        l.siteid
),

aprel_all AS (
    /*+ MATERIALIZE */
    SELECT
        COALESCE(l.dealid, f.dealid)   AS dealid,
        COALESCE(l.siteid, f.siteid)   AS siteid,
        COALESCE(l.arcdate, f.arcdate) AS arcdate,
        NVL(f.overdue_days, l.overdue_days_lpb) AS overdue_days,
        l.od_sum
    FROM (
        SELECT l.*
        FROM aprel_lpb l
        JOIN portfolio_base p
            ON  p.dealid = l.dealid
            AND p.siteid = l.siteid
    ) l
    FULL OUTER JOIN (
        SELECT
            p.dealid,
            p.siteid,
            f.arcdate,
            f.overdue_days
        FROM portfolio_base p
        JOIN aprel_fact f
            ON  f.dealid = p.dealid
            AND f.siteid = p.siteid
    ) f
        ON  f.dealid  = l.dealid
        AND f.siteid  = l.siteid
        AND f.arcdate = l.arcdate
),

may_all AS (
    /*+ MATERIALIZE */
    SELECT
        COALESCE(l.dealid, f.dealid)   AS dealid,
        COALESCE(l.siteid, f.siteid)   AS siteid,
        COALESCE(l.arcdate, f.arcdate) AS arcdate,
        NVL(f.overdue_days, l.overdue_days_lpb) AS overdue_days,
        l.od_sum
    FROM (
        SELECT l.*
        FROM may_lpb l
        JOIN portfolio_base p
            ON  p.dealid = l.dealid
            AND p.siteid = l.siteid
    ) l
    FULL OUTER JOIN (
        SELECT
            p.dealid,
            p.siteid,
            f.arcdate,
            f.overdue_days
        FROM portfolio_base p
        JOIN may_fact f
            ON  f.dealid = p.dealid
            AND f.siteid = p.siteid
    ) f
        ON  f.dealid  = l.dealid
        AND f.siteid  = l.siteid
        AND f.arcdate = l.arcdate
),

aprel_entry_Xplus AS (
    /*+ MATERIALIZE */
    SELECT
        s.bucket_name,
        s.entry_threshold,
        s.next_threshold,
        s.dealid,
        s.siteid,
        s.entry_date,
        NVL(al.od_sum, pb.od_sum_apr30) AS od_sum_april
    FROM (
        SELECT
            b.bucket_name,
            b.entry_threshold,
            b.next_threshold,
            a.dealid,
            a.siteid,
            MIN(a.arcdate) AS entry_date
        FROM bucket_map b
        JOIN aprel_all a
            ON a.overdue_days >= b.entry_threshold
        WHERE NOT EXISTS (
                  SELECT 1
                  FROM datamarts.fact_count_days_overdue f_prev
                  WHERE f_prev."Код сделки Кредита" = a.dealid
                    AND f_prev."МФО"                = a.siteid
                    AND f_prev."Дата отчета"        = DATE '2026-03-31'
                    AND f_prev."Макс.дни просрочки" >= b.entry_threshold
              )
          AND NOT EXISTS (
                  SELECT 1
                  FROM creator_k.Loan_Portfolio_Best lp_prev
                  LEFT JOIN creator_k.commercialloantype lntp_prev
                      ON lntp_prev.id = lp_prev.commercialloantypeid
                  WHERE lp_prev.dealid = a.dealid
                    AND lp_prev.siteid = a.siteid
                    AND lp_prev.arcdate = DATE '2026-03-31'
                    AND lp_prev.dealtypeid IN (355, 356)
                    AND lp_prev.toboid <> 1
                    AND (lp_prev.commercialloantypeid || '-' || lntp_prev.description)
                            NOT LIKE '%Реализация залога%'
                    AND NVL(lp_prev.overdue_days_max, 0) >= b.entry_threshold
                    AND NOT EXISTS (
                            SELECT 1
                            FROM datamarts.fact_count_days_overdue f_prev_any
                            WHERE f_prev_any."Код сделки Кредита" = a.dealid
                              AND f_prev_any."МФО"                = a.siteid
                              AND f_prev_any."Дата отчета"        = DATE '2026-03-31'
                        )
              )
        GROUP BY
            b.bucket_name,
            b.entry_threshold,
            b.next_threshold,
            a.dealid,
            a.siteid
    ) s
    LEFT JOIN aprel_lpb al
        ON  al.dealid  = s.dealid
        AND al.siteid  = s.siteid
        AND al.arcdate = s.entry_date
    LEFT JOIN portfolio_base pb
        ON  pb.dealid = s.dealid
        AND pb.siteid = s.siteid
),

may_jump_Xplus AS (
    /*+ MATERIALIZE */
    SELECT
        s.bucket_name,
        s.entry_threshold,
        s.next_threshold,
        s.dealid,
        s.siteid,
        s.jump_date,
        NVL(ml.od_sum, pb.od_sum_apr30) AS od_sum_may
    FROM (
        SELECT
            ae.bucket_name,
            ae.entry_threshold,
            ae.next_threshold,
            ae.dealid,
            ae.siteid,
            MIN(m.arcdate) AS jump_date
        FROM aprel_entry_Xplus ae
        JOIN may_all m
            ON  m.dealid       = ae.dealid
            AND m.siteid       = ae.siteid
            AND m.overdue_days >= ae.next_threshold
        WHERE NOT EXISTS (
                  SELECT 1
                  FROM datamarts.fact_count_days_overdue f_prev
                  WHERE f_prev."Код сделки Кредита" = ae.dealid
                    AND f_prev."МФО"                = ae.siteid
                    AND f_prev."Дата отчета"        = DATE '2026-04-30'
                    AND f_prev."Макс.дни просрочки" >= ae.next_threshold
              )
          AND NOT EXISTS (
                  SELECT 1
                  FROM creator_k.Loan_Portfolio_Best lp_prev
                  LEFT JOIN creator_k.commercialloantype lntp_prev
                      ON lntp_prev.id = lp_prev.commercialloantypeid
                  WHERE lp_prev.dealid = ae.dealid
                    AND lp_prev.siteid = ae.siteid
                    AND lp_prev.arcdate = DATE '2026-04-30'
                    AND lp_prev.dealtypeid IN (355, 356)
                    AND lp_prev.toboid <> 1
                    AND (lp_prev.commercialloantypeid || '-' || lntp_prev.description)
                            NOT LIKE '%Реализация залога%'
                    AND NVL(lp_prev.overdue_days_max, 0) >= ae.next_threshold
                    AND NOT EXISTS (
                            SELECT 1
                            FROM datamarts.fact_count_days_overdue f_prev_any
                            WHERE f_prev_any."Код сделки Кредита" = ae.dealid
                              AND f_prev_any."МФО"                = ae.siteid
                              AND f_prev_any."Дата отчета"        = DATE '2026-04-30'
                        )
              )
        GROUP BY
            ae.bucket_name,
            ae.entry_threshold,
            ae.next_threshold,
            ae.dealid,
            ae.siteid
    ) s
    LEFT JOIN may_lpb ml
        ON  ml.dealid  = s.dealid
        AND ml.siteid  = s.siteid
        AND ml.arcdate = s.jump_date
    LEFT JOIN portfolio_base pb
        ON  pb.dealid = s.dealid
        AND pb.siteid = s.siteid
),

cure_calc AS (
    /*+ MATERIALIZE */
    SELECT
        b.bucket_name,
        SUM(ae.od_sum_april) AS denominator_april,
        SUM(mj.od_sum_may)   AS numerator_may
    FROM bucket_map b
    LEFT JOIN aprel_entry_Xplus ae
        ON ae.bucket_name = b.bucket_name
    LEFT JOIN may_jump_Xplus mj
        ON  mj.bucket_name = ae.bucket_name
        AND mj.dealid      = ae.dealid
        AND mj.siteid      = ae.siteid
    GROUP BY b.bucket_name
)

SELECT
    c.bucket_name AS "Бакет",
    c.denominator_april AS "Знаменатель (апрель)",
    c.numerator_may     AS "Числитель (май)",
    ROUND(
        100 - (NVL(c.numerator_may, 0) / NULLIF(c.denominator_april, 0) * 100),
        2
    ) AS "Cure Rate %"
FROM cure_calc c
ORDER BY
    CASE c.bucket_name
        WHEN '1-30' THEN 1
        WHEN '31-60' THEN 2
        WHEN '61-90' THEN 3
        WHEN '91-120' THEN 4
        WHEN '121-150' THEN 5
        WHEN '151-180' THEN 6
    END;
